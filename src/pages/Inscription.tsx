const validateCEP = async (cep: string) => {
  try {
    // 1. Busca endereço na BrasilAPI (V2)
    // A V2 é mais completa e às vezes já retorna coordenadas, mas manteremos o fluxo
    // do Nominatim para garantir precisão com o nome da rua.
    const brasilApiResponse = await axios.get(`https://brasilapi.com.br/api/cep/v2/${cep}`);

    // O Axios joga erro no 404, mas verificamos os dados por segurança
    if (!brasilApiResponse.data || !brasilApiResponse.data.street) {
      throw new Error("CEP não encontrado ou incompleto");
    }

    const { street, neighborhood, city, state } = brasilApiResponse.data;

    // Mapeamento: BrasilAPI (Inglês) -> Padrão ViaCEP (Português)
    // Isso garante que o resto do seu código (AddressInfo e UI) continue funcionando
    const addressData = {
      logradouro: street,
      bairro: neighborhood,
      localidade: city,
      uf: state,
      cep: cep
    };

    // 2. Obter coordenadas via Nominatim
    const addressQuery = `${addressData.logradouro}, ${addressData.localidade}, ${addressData.uf}, Brazil`;
    const nominatimResponse = await axios.get(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}`
    );

    if (!nominatimResponse.data.length) {
      throw new Error("Localização não encontrada no mapa");
    }

    const { lat, lon } = nominatimResponse.data[0];

    // 3. Buscar escolas usando Overpass API
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

    // Processar escolas
    const schools = overpassResponse.data.elements
      .filter((element: any) => element.tags && element.tags.name)
      .map((element: any) => ({
        id: element.id.toString(),
        name: element.tags.name,
        type: element.tags.school_type || 'Escola pública',
        // Fallback seguro para lat/lon caso o elemento seja uma 'way' ou 'relation' sem centro definido
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
