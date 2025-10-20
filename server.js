const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const app = express();

// Configuración CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, eCrewHeader');
  
  // Manejar preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(bodyParser.json());
app.use(express.static('public'));

// --- Funciones de ayuda ---
function generateUUID() {
  return "xxxx-xxxx-4xxx-yxxx".replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function formatFlightDate(inputDate) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(inputDate)) {
    return inputDate;
  }
  const parts = inputDate.split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    return `${day}/${month}/${year}`;
  }
  throw new Error(`Formato de fecha no soportado: ${inputDate}`);
}

// --- Funciones eCrew ---
async function loginToECrew(crewId, password) {
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  try {
    const htmlResponse = await axios.get("https://i2-crew.aims.aero/eCrew", {
      headers: { "User-Agent": USER_AGENT }
    });

    const winObjMatch = htmlResponse.data.match(/winObj:"([a-f0-9]+)"/);
    const loginUrlMatch = htmlResponse.data.match(/EcallUrlAsync\("(\/eCrew\/Login\/[a-zA-Z0-9_-]+)"/);
    
    if (!winObjMatch || !loginUrlMatch) throw new Error("No se encontró winObj o URL de login");

    const winObj = winObjMatch[1];
    const loginUrl = "https://i2-crew.aims.aero" + loginUrlMatch[1];
    const passwordHash = CryptoJS.SHA512(password).toString();
    const eCrewHeader = generateUUID();

    const loginResponse = await axios.post(
      loginUrl,
      {
        crewid: crewId,
        password: passwordHash,
        winObj: winObj,
        chk: "",
        cio: "",
        alias: "",
        rad: "",
        hotp: ""
      },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "eCrewHeader": eCrewHeader,
          "Origin": "https://i2-crew.aims.aero"
        },
      }
    );

    return {
      cookies: loginResponse.headers["set-cookie"].join("; "),
      eCrewHeader
    };
  } catch (error) {
    console.error("Error en login:", error.response?.data || error.message);
    return null;
  }
}

function parseFlights(data) {
  if (!Array.isArray(data)) {
    console.error('Datos de vuelos no son un array:', data);
    return [];
  }

  function hhmmToMinutes(hhmm) {
    if (hhmm === "---") return null;
    const hours = parseInt(hhmm.substring(0, 2));
    const minutes = parseInt(hhmm.substring(2));
    return hours * 60 + minutes;
  }

  return data.map(vuelo => {
    try {
      const salidaProgramada = vuelo.departure?.match(/<span style='padding-left: 15px'>(\d{4})<\/span>/)?.[1] || "---";
      const salidaReal = vuelo.departure?.match(/<span style='padding-left: 15px'>A(\d{4})<\/span>/)?.[1] || "---";
      const llegadaProgramada = vuelo.arrival?.match(/<span style='padding-left: 15px'>(\d{4})<\/span>/)?.[1] || "---";
      const llegadaReal = vuelo.arrival?.match(/<span style='padding-left: 15px'>A(\d{4})<\/span>/)?.[1] || "---";
      const llegadaEstimada = vuelo.arrival?.match(/<span style='padding-left: 15px'>E(\d{4})<\/span>/)?.[1] || "---";

      function hhmmToMinutes(hhmm) {
        if (hhmm === "---") return null;
        const hours = parseInt(hhmm.substring(0, 2));
        const minutes = parseInt(hhmm.substring(2));
        return hours * 60 + minutes;
      }

      let estado, llegadaAUtilizar;
      if (salidaReal === "---" && llegadaReal === "---") {
        estado = "Programado";
        llegadaAUtilizar = llegadaProgramada;
      } else if (salidaReal !== "---" && llegadaReal === "---") {
        estado = "En Vuelo";
        llegadaAUtilizar = llegadaEstimada !== "---" ? llegadaEstimada : llegadaProgramada;
      } else {
        estado = "Completado";
        llegadaAUtilizar = llegadaReal;
      }

      if (estado === "En Vuelo" || estado === "Completado") {
        const programadaMin = hhmmToMinutes(llegadaProgramada);
        const utilizadaMin = hhmmToMinutes(llegadaAUtilizar);
        if (programadaMin !== null && utilizadaMin !== null) {
          const retraso = utilizadaMin - programadaMin;
          if (retraso > 0) {
            if (estado === "En Vuelo") {
              estado = `En Vuelo (Retraso +${retraso} min)`;
            } else {
              estado = `Completado (Retraso +${retraso} min)`;
            }
          } else if (estado === "Completado") {
            estado = "Completado (A tiempo)";
          }
        }
      }

      const extractIATA = (html) => {
        if (!html) return "---";
        const firstSpanMatch = html.match(/<span>([A-Z]{3})\s<\/span>/);
        if (firstSpanMatch) return firstSpanMatch[1].trim();
        const fallbackMatch = html.match(/([A-Z]{3})\s*<\/span>/);
        return fallbackMatch?.[1] || "---";
      };

      return {
        matricula: vuelo.registrations?.match(/EC[A-Z0-9]{3}/)?.[0] || "---",
        aircraftRegistration: vuelo.registrations?.match(/EC[A-Z0-9]{3}/)?.[0] || "---",
        numero: "IBS" + (vuelo.flight?.replace(/<[^>]+>/g, "").trim() || "---"),
        salidaProgramada,
        salidaReal,
        llegadaProgramada,
        llegadaReal,
        llegadaEstimada,
        llegadaAUtilizar,
        estado,
        gate: vuelo.stand_gate?.match(/<span>([^<]+)<\/span><br><span>([^<]+)<\/span>/)?.[2] || "-/-",
        passengers: vuelo.passengers?.match(/<span>([^<]+)<\/span>/)?.[1] || "0/0",
        origen: extractIATA(vuelo.departure),
        destino: extractIATA(vuelo.arrival)
      };
    } catch (error) {
      console.error('Error parseando vuelo:', error, vuelo);
      return null;
    }
  }).filter(vuelo => vuelo !== null);
}

function restarUnDia(fecha) {
  const [day, month, year] = fecha.split('/');
  const dateObj = new Date(`${year}-${month}-${day}`);
  dateObj.setDate(dateObj.getDate() - 1);
  const newDay = String(dateObj.getDate()).padStart(2, '0');
  const newMonth = String(dateObj.getMonth() + 1).padStart(2, '0');
  const newYear = dateObj.getFullYear();
  return `${newDay}/${newMonth}/${newYear}`;
}

// --- Endpoints API ---
app.post('/api/login', async (req, res) => {
  const { crewId, password } = req.body;
  if (!crewId || !password) {
    return res.status(400).json({ error: 'Se requieren crewId y password' });
  }
  try {
    const sessionData = await loginToECrew(crewId, password);
    if (!sessionData) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    res.json({
      success: true,
      cookies: sessionData.cookies,
      eCrewHeader: sessionData.eCrewHeader
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/crew', async (req, res) => {
  try {
    const { cookies, eCrewHeader, flightNumber, depAirport, day } = req.body;
    if (!cookies || !eCrewHeader || !flightNumber || day === undefined) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const payload = {
      LegId: JSON.stringify({
        Day: day,
        Dep: depAirport || " ",
        Carrier: 1,
        Flt: parseInt(flightNumber),
        LegCd: " "
      })
    };

    const response = await axios.post(
      "https://i2-crew.aims.aero/eCrew/FlightInformation/ShowCrewOnFlight",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "eCrewHeader": eCrewHeader,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          "Origin": "https://i2-crew.aims.aero",
          "Referer": `https://i2-crew.aims.aero/eCrew/FlightInformation?eCrewHeader=${eCrewHeader}`
        }
      }
    );

    if (Array.isArray(response.data)) {
      res.json({ crew: response.data });
    } else {
      res.json({ crew: [] });
    }
  } catch (error) {
    console.error('Error en endpoint /api/crew:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Error al obtener tripulación',
      details: error.response?.data || error.message
    });
  }
});

app.post('/api/flights', async (req, res) => {
  try {
    const { cookies, eCrewHeader, matriculas, fecha } = req.body;
    if (!cookies || !eCrewHeader || !matriculas || !fecha) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const formattedDate = formatFlightDate(fecha);
    const resultados = [];

    for (const matricula of matriculas) {
      try {
        const response = await axios.post(
          "https://i2-crew.aims.aero/eCrew/FlightInformation/FetchFlightInfoAction",
          {
            ACReg: matricula,
            ACType: "",
            ForDate: formattedDate,
            OptionIdx: "7",
            TimesIn: "3"
          },
          {
            headers: {
              "Content-Type": "application/json",
              "Cookie": cookies,
              "eCrewHeader": eCrewHeader,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
              "Origin": "https://i2-crew.aims.aero",
              "Referer": "https://i2-crew.aims.aero/eCrew/FlightInformation/FlightInfo"
            }
          }
        );

        const vuelos = parseFlights(response.data);
        if (vuelos.length > 0) {
          resultados.push(...vuelos);
        }
      } catch (error) {
        console.error(`Error consultando ${matricula}:`, error.response?.data || error.message);
        continue;
      }
    }

    res.json({ vuelos: resultados });
  } catch (error) {
    console.error('Error en endpoint /api/flights:', error);
    res.status(500).json({
      error: 'Error al obtener vuelos',
      details: error.message
    });
  }
});

app.post('/api/flight-details', async (req, res) => {
  try {
    const { cookies, eCrewHeader, flightNumber, fecha } = req.body;
    if (!cookies || !eCrewHeader || !flightNumber || !fecha) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    const formattedDate = restarUnDia(fecha);
    const response = await axios.post(
      "https://i2-crew.aims.aero/eCrew/FlightInformation/FetchFlightInfoAction",
      {
        ACReg: "",
        ACType: "",
        Airport: "",
        ArrDep: 0,
        Carrier: "",
        FlightNo: flightNumber,
        ForDate: formattedDate,
        OptionIdx: "4",
        TimesIn: "3"
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "eCrewHeader": eCrewHeader,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          "Origin": "https://i2-crew.aims.aero",
          "Referer": "https://i2-crew.aims.aero/eCrew/FlightInformation/FlightInfo"
        }
      }
    );

    const vuelos = parseFlights(response.data);
    res.json({
      success: true,
      details: vuelos.length > 0 ? vuelos[0] : null
    });
  } catch (error) {
    console.error('Error en endpoint /api/flight-details:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener detalles del vuelo',
      details: error.response?.data || error.message
    });
  }
});

app.post('/api/get-crew-schedule-key', async (req, res) => {
  console.log('Iniciando solicitud de Key...');
  try {
    const { cookies, eCrewHeader } = req.body;
    if (!cookies || !eCrewHeader) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren cookies y eCrewHeader'
      });
    }

    const response = await axios.get(`https://i2-crew.aims.aero/eCrew/CrewSchedule?eCrewHeader=${eCrewHeader}`, {
      headers: {
        'Cookie': cookies,
        'Referer': 'https://i2-crew.aims.aero/eCrew/Dashboard/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'eCrewHeader': eCrewHeader,
      },
      responseType: 'text',
      maxRedirects: 0,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });

    const keyPatterns = [
      /name="Key"\s+value="([^"]+)"/,
      /id="Key"\s+value="([^"]+)"/,
      /Key["']?\s*:\s*["']([^"']+)/i,
      /data-key=["']([^"']+)/i,
      /window\.Key\s*=\s*["']([^"']+)/i,
      /"key"\s*:\s*"([^"]+)"/i,
      /Key\s*=\s*"([^"]+)"/i
    ];

    let key = null;
    for (const pattern of keyPatterns) {
      const match = response.data.match(pattern);
      if (match && match[1]) {
        key = match[1];
        break;
      }
    }

    if (!key) {
      return res.status(500).json({
        success: false,
        error: 'Key no encontrada en la respuesta'
      });
    }

    return res.json({ success: true, key });
  } catch (error) {
    console.error('Error completo:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/retrieve-schedule-data', async (req, res) => {
  try {
    const { cookies, eCrewHeader, initialKey, fromDate, toDate } = req.body;
    if (!cookies || !eCrewHeader || !initialKey) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos'
      });
    }

    const retrievePayload = {
      Key: initialKey,
      Data: JSON.stringify({
        FromDate: fromDate,
        ToDate: toDate,
        Timesin: "3",
        CrewIDS: "",
        PeriodSelect: false
      })
    };

    const response = await axios.post(
      'https://i2-crew.aims.aero/eCrew/CrewSchedule/Retrieve',
      retrievePayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookies,
          'eCrewHeader': eCrewHeader,
          'Origin': 'https://i2-crew.aims.aero',
          'Referer': `https://i2-crew.aims.aero/eCrew/CrewSchedule?eCrewHeader=${eCrewHeader}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
        }
      }
    );

    if (!response.data) {
      throw new Error('La respuesta de /Retrieve está vacía');
    }

    res.json({
      success: true,
      tempKey: response.data
    });
  } catch (error) {
    console.error('Error en /api/retrieve-schedule-data:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/get-scheduler-events', async (req, res) => {
  try {
    const { cookies, eCrewHeader, tempKey } = req.body;

    if (!tempKey || typeof tempKey !== 'string' || tempKey.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'El tempKey no es válido'
      });
    }

    const payload = {
      Key: tempKey,
      Data: tempKey
    };

    const response = await axios.post(
      'https://i2-crew.aims.aero/eCrew/CrewSchedule/SchedulerEvents',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookies,
          'eCrewHeader': eCrewHeader,
          'Origin': 'https://i2-crew.aims.aero',
          'Referer': `https://i2-crew.aims.aero/eCrew/CrewSchedule?eCrewHeader=${eCrewHeader}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
        },
        transformResponse: [data => data],
        validateStatus: (status) => status < 500
      }
    );

    if (response.status !== 200) {
      return res.status(400).json({
        success: false,
        error: `El servidor respondió con estado ${response.status}`
      });
    }

    res.json({
      success: true,
      events: response.data
    });
  } catch (error) {
    console.error('Error completo:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
