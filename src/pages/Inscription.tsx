import React, { useState, useEffect } from "react";
import { Check, MapPin, DollarSign, GraduationCap, Award, Search } from "lucide-react";
import { useLocation } from "../context/LocationContext";
import { useUser } from "../context/UserContext";
import ReactPixel from "react-facebook-pixel";
import { hashUserData } from "../utils/pixel";
import useUtmNavigator from "../hooks/useUtmNavigator";
import { usePixelTracking } from '../hooks/usePixelTracking';
import axios from "axios";

interface School {
	id: string;
	name: string;
	type: string;
	distance: number;
}

interface AddressInfo {
	cep: string;
	logradouro: string;
	bairro: string;
	localidade: string;
	uf: string;
	codigoRegiao: string;
	pontoAtendimento: string;
	vagasDisponiveis: number;
	nearbySchools: School[];
}

interface UserInfo {
	cpf: string;
	nome: string;
	nome_mae: string;
	data_nascimento: string;
	sexo: string;
}

interface VerificationStep {
	label: string;
	status: "pending" | "processing" | "completed";
}

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
	const R = 6371; // Earth's radius in km
	const dLat = (lat2 - lat1) * Math.PI / 180;
	const dLon = (lon2 - lon1) * Math.PI / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
		Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
};

const validateCEP = async (cep: string) => {
	try {
		// 1. Get address from BrasilAPI (substituindo ViaCEP)
		const brasilApiResponse = await axios.get(`https://brasilapi.com.br/api/cep/v2/${cep}`);
		
		const { street, neighborhood, city, state, location } = brasilApiResponse.data;

		// Mapear retorno da BrasilAPI para o formato que o front espera (compatibilidade com ViaCEP)
		const addressData = {
			logradouro: street,
			bairro: neighborhood,
			localidade: city,
			uf: state,
			cep: cep
		};

		let lat: number;
		let lon: number;

		// 2. Tenta usar coordenadas da BrasilAPI, se falhar usa Nominatim
		if (location && location.coordinates && location.coordinates.latitude) {
			lat = parseFloat(location.coordinates.latitude);
			lon = parseFloat(location.coordinates.longitude);
		} else {
			// Fallback: Get coordinates from Nominatim
			const addressString = `${street}, ${city}, ${state}, Brazil`;
			const nominatimResponse = await axios.get(
				`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressString)}`
			);

			if (!nominatimResponse.data.length) {
				throw new Error("Localização não encontrada");
			}
			lat = parseFloat(nominatimResponse.data[0].lat);
			lon = parseFloat(nominatimResponse.data[0].lon);
		}

		// 3. Search for schools using Overpass API
		const overpassQuery = `
      [out:json][timeout:25];
      (
        node["amenity"="school"](around:10000,${lat},${lon});
        way["amenity"="school"](around:10000,${lat},${lon});
        relation["amenity"="school"](around:10000,${lat},${lon});
      );
      out body;
      >;
      out skel qt;
    `;

		const overpassResponse = await axios.post(
			'https://overpass-api.de/api/interpreter',
			overpassQuery,
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				}
			}
		);

		// Process schools
		const schools = overpassResponse.data.elements
			.filter((element: any) => element.tags && element.tags.name)
			.map((element: any) => ({
				id: element.id.toString(),
				name: element.tags.name,
				type: element.tags.school_type || 'Escola pública',
				distance: calculateDistance(lat, lon, element.lat || lat, element.lon || lon)
			}))
			.sort((a: School, b: School) => a.distance - b.distance)
			.slice(0, 3);

		return {
			address: addressData,
			schools,
			coordinates: { lat, lon }
		};
	} catch (error) {
		console.error('Error fetching location data:', error);
		throw error;
	}
};

const validateCPFFromAPI = async (cpf: string): Promise<{ valid: boolean; data?: UserInfo }> => {
	const numericCPF = cpf.replace(/\D/g, "");

	if (numericCPF.length !== 11) {
		return { valid: false };
	}

	if (/^(\d)\1{10}$/.test(numericCPF)) {
		return { valid: false };
	}

	let sum = 0;
	for (let i = 0; i < 9; i++) {
		sum += parseInt(numericCPF.charAt(i)) * (10 - i);
	}
	let digit1 = 11 - (sum % 11);
	if (digit1 > 9) digit1 = 0;

	sum = 0;
	for (let i = 0; i < 10; i++) {
		sum += parseInt(numericCPF.charAt(i)) * (11 - i);
	}
	let digit2 = 11 - (sum % 11);
	if (digit2 > 9) digit2 = 0;

	if (parseInt(numericCPF.charAt(9)) !== digit1 || parseInt(numericCPF.charAt(10)) !== digit2) {
		return { valid: false };
	}

	try {
		// Consultar nova API de CPF (magmadatahub)
		// A resposta esperada contém: cpf, nome, sexo, nascimento (dd/mm/YYYY), nome_mae
		const response = await axios.get(
			`https://magmadatahub.com/api.php?token=bef7dbfe0994308f734fbfb4e2a0dec17aa7baed9f53a0f5dd700cf501f39f26&cpf=${numericCPF}`
		);

		if (response.data && response.data.cpf) {
			// Converter data de nascimento de dd/mm/YYYY para YYYY-MM-DD para garantir compatibilidade com new Date()
			let isoDate = "";
			if (response.data.nascimento) {
				const parts = String(response.data.nascimento).split("/");
				if (parts.length === 3) {
					isoDate = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
				} else {
					isoDate = response.data.nascimento;
				}
			}

			// Normalizar sexo para 'M' ou 'F'
			let sexoNormalized = "";
			if (response.data.sexo) {
				const s = String(response.data.sexo).toLowerCase();
				if (s.startsWith("m")) sexoNormalized = "M";
				else sexoNormalized = "F";
			}

			return {
				valid: true,
				data: {
					cpf: response.data.cpf,
					nome: response.data.nome || "",
					nome_mae: response.data.nome_mae || "",
					data_nascimento: isoDate,
					sexo: sexoNormalized
				}
			};
		}
	} catch (error) {
		console.error('Erro ao consultar API de CPF:', error);
	}

	return { valid: true };
};

const Inscription: React.FC = () => {
	usePixelTracking();

	const navigate = useUtmNavigator();
	const [cep, setCep] = useState("");
	const [cpf, setCpf] = useState("");
	const [addressInfo, setAddressInfo] = useState<AddressInfo | null>(null);
	const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [acceptedTerms, setAcceptedTerms] = useState(false);
	const [verificationSteps, setVerificationSteps] = useState<VerificationStep[]>([
		{ label: "Validando CPF", status: "pending" },
		{ label: "Verificando Nome", status: "pending" },
		{ label: "Verificando Nome da Mãe", status: "pending" },
		{ label: "Validando Data de Nascimento", status: "pending" },
		{ label: "Verificando Elegibilidade", status: "pending" },
	]);
	const [isVerifying, setIsVerifying] = useState(false);
	const [verificationComplete, setVerificationComplete] = useState(false);
	const [name, setName] = useState("");

	const { setLocationInfo } = useLocation();
	const { setUserName } = useUser();

	const [showVerifyingPopup, setShowVerifyingPopup] = useState(false);
	const [showAvailablePopup, setShowAvailablePopup] = useState(false);
	const [currentStep, setCurrentStep] = useState(0);

	useEffect(() => {
		ReactPixel.init("617874301266607");

		ReactPixel.track("PageView", {
			event_name: "PageView",
			event_time: Math.floor(Date.now() / 1000),
			event_id: "PageView_" + Date.now(),
			action_source: "website",
			user_data: hashUserData({}),
			custom_data: {
				order_id: "",
				currency: "BRL",
				value: 0,
				content_name: "",
				content_ids: "",
				contents: "",
				num_items: 1,
			},
		});
	}, []);

	const formatCEP = (value: string) => {
		const numbers = value.replace(/\D/g, "");
		if (numbers.length <= 5) return numbers;
		return `${numbers.slice(0, 5)}-${numbers.slice(5, 8)}`;
	};

	const formatCPF = (value: string) => {
		const numbers = value.replace(/\D/g, "");
		if (numbers.length <= 3) return numbers;
		if (numbers.length <= 6) return `${numbers.slice(0, 3)}.${numbers.slice(3)}`;
		if (numbers.length <= 9) return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6)}`;
		return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6, 9)}-${numbers.slice(9, 11)}`;
	};

	const handleCEPChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const formatted = formatCEP(e.target.value);
		if (formatted.length <= 9) {
			setCep(formatted);
		}
	};

	const validateCEPAndFindSchools = async () => {
		setLoading(true);
		setError("");
		setAddressInfo(null);
		setShowVerifyingPopup(true);
		setCurrentStep(0);

		try {
			const cleanCEP = cep.replace(/\D/g, "");

			await new Promise(resolve => setTimeout(resolve, 2000));
			setCurrentStep(1);

			const locationData = await validateCEP(cleanCEP);

			setCurrentStep(2);
			await new Promise(resolve => setTimeout(resolve, 1500));

			const addressInfo: AddressInfo = {
				cep: cleanCEP,
				logradouro: locationData.address.logradouro,
				bairro: locationData.address.bairro,
				localidade: locationData.address.localidade,
				uf: locationData.address.uf,
				codigoRegiao: `${locationData.address.uf}-${Math.floor(Math.random() * 90 + 10)}-${Math.floor(Math.random() * 900 + 100)}`,
				pontoAtendimento: locationData.schools[0]?.name || "Unidade Central",
				vagasDisponiveis: Math.floor(Math.random() * 50) + 1,
				nearbySchools: locationData.schools
			};

			setAddressInfo(addressInfo);
			setLocationInfo(cleanCEP, locationData.schools);

			setShowVerifyingPopup(false);
			await new Promise(resolve => setTimeout(resolve, 500));
			setShowAvailablePopup(true);
			await new Promise(resolve => setTimeout(resolve, 3000));
			setShowAvailablePopup(false);

		} catch (err) {
			console.error(err);
			setError("CEP não encontrado. Por favor
