const axios = require('axios');

// Teste com um CEP válido - São Paulo
const testCEP = '01310100';

console.log('=== TESTE DE VALIDAÇÃO DE CEP ===\n');

// Função para calcular distância
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const validateCEP = async (cep) => {
  try {
    console.log(`📍 Testando CEP: ${cep}\n`);

    // 1. Busca endereço na BrasilAPI (V2)
    console.log('1️⃣  Consultando BrasilAPI...');
    const brasilApiResponse = await axios.get(`https://brasilapi.com.br/api/cep/v2/${cep}`, {
      timeout: 10000
    });

    console.log('✅ BrasilAPI respondeu:', JSON.stringify(brasilApiResponse.data, null, 2));

    if (!brasilApiResponse.data || !brasilApiResponse.data.street) {
      throw new Error("CEP não encontrado ou incompleto");
    }

    const { street, neighborhood, city, state, cep: cepFormatado } = brasilApiResponse.data;

    const addressData = {
      logradouro: street,
      bairro: neighborhood,
      localidade: city,
      uf: state,
      cep: cepFormatado
    };

    console.log('\n2️⃣  Dados do endereço mapeados:');
    console.log(JSON.stringify(addressData, null, 2));

    // 2. Obter coordenadas via Nominatim
    console.log('\n3️⃣  Consultando Nominatim para coordenadas...');
    const addressQuery = `${addressData.logradouro}, ${addressData.localidade}, ${addressData.uf}, Brazil`;
    console.log(`   Query: "${addressQuery}"`);

    const nominatimResponse = await axios.get(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}`,
      {
        headers: {
          'User-Agent': 'AgenteEscolaApp'
        },
        timeout: 10000
      }
    );

    console.log('✅ Nominatim respondeu com', nominatimResponse.data.length, 'resultado(s)');
    if (nominatimResponse.data.length > 0) {
      console.log('   Primeiro resultado:', JSON.stringify(nominatimResponse.data[0], null, 2));
    }

    if (!nominatimResponse.data || nominatimResponse.data.length === 0) {
      throw new Error("Localização não encontrada no mapa");
    }

    const { lat, lon } = nominatimResponse.data[0];
    console.log(`\n   Coordenadas obtidas: ${lat}, ${lon}`);

    // 3. Buscar escolas usando Overpass API
    console.log('\n4️⃣  Consultando Overpass API para escolas...');
    const overpassQuery = `
      [out:json][timeout:30];
      (
        node["amenity"="school"](around:10000,${lat},${lon});
        way["amenity"="school"](around:10000,${lat},${lon});
        relation["amenity"="school"](around:10000,${lat},${lon});
      );
      out center;
    `;

    console.log('   Query Overpass:', overpassQuery.replace(/\n/g, ' ').slice(0, 100) + '...');

    const overpassResponse = await axios.post(
      'https://overpass-api.de/api/interpreter',
      overpassQuery,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 35000
      }
    );

    console.log('✅ Overpass respondeu com', overpassResponse.data.elements.length, 'elementos');

    // Função para extrair coordenadas
    const getCoordinates = (element) => {
      if (element.lat !== undefined && element.lon !== undefined) {
        return { lat: element.lat, lon: element.lon };
      }
      if (element.center?.lat !== undefined && element.center?.lon !== undefined) {
        return { lat: element.center.lat, lon: element.center.lon };
      }
      return null;
    };

    // Função para filtrar escolas públicas
    const isPublicSchool = (element) => {
      const name = (element.tags?.name || '').toLowerCase();
      const operator = (element.tags?.operator || '').toLowerCase();
      const operatorType = (element.tags?.['operator:type'] || '').toLowerCase();
      const fee = element.tags?.fee;

      if (operatorType === 'private' || name.includes('particular')) {
        return false;
      }

      if (fee === 'yes') {
        return false;
      }

      if (name.includes('autoescola') || name.includes('auto escola') || 
          name.includes('cursos') || name.includes('academia') ||
          name.includes('treinamento') || name.includes('centro de treinamento')) {
        return false;
      }

      return true;
    };

    // Função para classificar tipo de escola
    const getSchoolType = (element) => {
      const name = element.tags?.name || '';
      const operator = element.tags?.operator || '';

      if (name.includes('Estadual') || name.includes('E.E.') || operator.includes('Estadual')) {
        return 'Escola Estadual';
      }
      if (name.includes('Municipal') || name.includes('E.M.') || operator.includes('Municipal')) {
        return 'Escola Municipal';
      }
      return 'Escola Pública';
    };

    // Processar escolas
    console.log('\n5️⃣  Processando e filtrando escolas...');
    const schools = (overpassResponse.data.elements || [])
      .filter(element => {
        if (!element.tags || !element.tags.name) return false;
        return isPublicSchool(element);
      })
      .map(element => {
        const coords = getCoordinates(element);
        if (!coords) return null;

        return {
          id: element.id.toString(),
          name: element.tags.name,
          type: getSchoolType(element),
          distance: calculateDistance(lat, lon, coords.lat, coords.lon)
        };
      })
      .filter(school => school !== null)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);

    console.log(`✅ ${schools.length} escolas públicas encontradas e filtradas\n`);
    console.log('🏫 TOP 3 ESCOLAS MAIS PRÓXIMAS:');
    schools.forEach((school, index) => {
      console.log(`\n   ${index + 1}. ${school.name}`);
      console.log(`      Tipo: ${school.type}`);
      console.log(`      Distância: ${school.distance.toFixed(2)} km`);
    });

    return {
      address: addressData,
      schools,
      coordinates: { lat, lon }
    };

  } catch (error) {
    console.error('\n❌ ERRO:', error.message);
    if (error.response?.data) {
      console.error('   Resposta da API:', JSON.stringify(error.response.data, null, 2));
    }
    if (error.code) {
      console.error('   Código de erro:', error.code);
    }
    throw error;
  }
};

// Executar teste
validateCEP(testCEP)
  .then(() => {
    console.log('\n✅ Teste concluído com sucesso!');
    process.exit(0);
  })
  .catch(err => {
    console.log('\n❌ Teste falhou');
    process.exit(1);
  });
