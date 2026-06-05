const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { origin: "*" } 
});

// Servir archivos estáticos (la pantalla del juego)
app.use(express.static('public'));
app.use(cors());

// ========== BASE DE DATOS SIMPLE DE PREGUNTAS ==========
const preguntas = [
  {
    id: "P001",
    pregunta: "Menciona algo que haces cuando tienes hambre",
    respuestas: [
      { texto: "Comer", puntos: 45, orden: 1 },
      { texto: "Buscar comida", puntos: 25, orden: 2 },
      { texto: "Refrigerador", puntos: 15, orden: 3 },
      { texto: "Pedir delivery", puntos: 10, orden: 4 },
      { texto: "Quejarse", puntos: 5, orden: 5 }
    ]
  },
  {
    id: "P002",
    pregunta: "¿Qué le pides prestado a tu vecino?",
    respuestas: [
      { texto: "Azúcar", puntos: 40, orden: 1 },
      { texto: "Sal", puntos: 25, orden: 2 },
      { texto: "Herramientas", puntos: 20, orden: 3 },
      { texto: "Dinero", puntos: 10, orden: 4 },
      { texto: "WiFi", puntos: 5, orden: 5 }
    ]
  },
  {
    id: "P003",
    pregunta: "Menciona una excusa para llegar tarde al trabajo",
    respuestas: [
      { texto: "Tráfico", puntos: 50, orden: 1 },
      { texto: "Despertador", puntos: 25, orden: 2 },
      { texto: "Transporte", puntos: 15, orden: 3 },
      { texto: "Emergencia familiar", puntos: 7, orden: 4 },
      { texto: "Se me olvidó", puntos: 3, orden: 5 }
    ]
  }
];

// ========== ESTADO DEL JUEGO ==========
const salas = {};

class SalaJuego {
  constructor(id) {
    this.id = id;
    this.equipos = { A: [], B: [] };
    this.preguntaActual = null;
    this.buzzersActivos = false;
    this.puntos = { A: 0, B: 0 };
    this.ronda = 1;
    this.strikes = 0;
    this.equipoJugando = null;
    this.respuestasReveladas = [];
    this.estado = 'esperando'; // esperando, preguntando, revelando, terminado
  }

  obtenerPreguntaAleatoria() {
    const disponibles = preguntas.filter(p => !this.respuestasReveladas.includes(p.id));
    if (disponibles.length === 0) return null;
    return disponibles[Math.floor(Math.random() * disponibles.length)];
  }

  activarBuzzers() {
    this.buzzersActivos = true;
    this.primerBuzz = null;
    io.to(this.id).emit('BUZZERS_ACTIVADOS');
  }

  procesarBuzz(jugadorId, timestamp) {
    if (!this.buzzersActivos || this.primerBuzz) return false;
    
    this.primerBuzz = { jugadorId, timestamp };
    this.buzzersActivos = false;
    
    const jugador = this.encontrarJugador(jugadorId);
    const equipo = jugador ? jugador.equipo : null;
    
    io.to(this.id).emit('GANADOR_BUZZ', { 
      jugadorId, 
      nombre: jugador ? jugador.nombre : 'Desconocido',
      equipo,
      tiempo: Date.now() - timestamp 
    });
    return true;
  }

  encontrarJugador(jugadorId) {
    for (let eq of ['A', 'B']) {
      const jugador = this.equipos[eq].find(j => j.id === jugadorId);
      if (jugador) return { ...jugador, equipo: eq };
    }
    return null;
  }

  validarRespuesta(textoRespuesta) {
    const pregunta = this.preguntaActual;
    if (!pregunta) return { correcta: false };
    
    const normalizada = this.normalizarTexto(textoRespuesta);
    
    for (let respuesta of pregunta.respuestas) {
      if (this.calcularSimilitud(normalizada, this.normalizarTexto(respuesta.texto)) > 0.75) {
        return {
          correcta: true,
          respuesta: respuesta,
          esTop: respuesta.orden === 1
        };
      }
    }
    return { correcta: false };
  }

  normalizarTexto(texto) {
    if (!texto) return '';
    return texto.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
  }

  calcularSimilitud(str1, str2) {
    if (str1 === str2) return 1;
    if (str1.includes(str2) || str2.includes(str1)) return 0.9;
    // Distancia simple de Levenshtein (versión básica)
    const len = Math.max(str1.length, str2.length);
    let coincidencias = 0;
    for (let i = 0; i < Math.min(str1.length, str2.length); i++) {
      if (str1[i] === str2[i]) coincidencias++;
    }
    return coincidencias / len;
  }

  agregarStrike() {
    this.strikes++;
    io.to(this.id).emit('STRIKE', { 
      strikes: this.strikes,
      equipo: this.equipoJugando 
    });
    
    if (this.strikes >= 3) {
      this.estado = 'robo';
      const equipoOpuesto = this.equipoJugando === 'A' ? 'B' : 'A';
      io.to(this.id).emit('OPORTUNIDAD_ROBO', {
        equipoOpuesto,
        puntosEnJuego: this.calcularPuntosEnJuego()
      });
    }
  }

  calcularPuntosEnJuego() {
    if (!this.preguntaActual) return 0;
    let puntos = 0;
    for (let r of this.preguntaActual.respuestas) {
      if (this.respuestasReveladas.includes(r.texto)) {
        puntos += r.puntos;
      }
    }
    // Multiplicador por ronda
    if (this.ronda === 4) puntos *= 2;
    if (this.ronda === 5) puntos *= 3;
    return puntos;
  }

  revelarRespuesta(respuesta) {
    this.respuestasReveladas.push(respuesta.texto);
    io.to(this.id).emit('RESPUESTA_REVELADA', {
      respuesta,
      puntosTotales: this.calcularPuntosEnJuego()
    });
  }

  sumarPuntos(equipo, puntos) {
    this.puntos[equipo] += puntos;
    io.to(this.id).emit('PUNTOS_ACTUALIZADOS', this.puntos);
  }
}

function generarCodigo() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== EVENTOS DE SOCKET ==========
io.on('connection', (socket) => {
  console.log('Nuevo jugador conectado:', socket.id);

  // Crear sala
  socket.on('CREAR_SALA', () => {
    const salaId = generarCodigo();
    salas[salaId] = new SalaJuego(salaId);
    socket.join(salaId);
    socket.salaId = salaId;
    socket.esPresentador = true;
    
    socket.emit('SALA_CREADA', { 
      salaId,
      urlJuego: `https://tu-juego.com/sala/${salaId}`,
      urlControl: `https://tu-juego.com/control/${salaId}`
    });
    
    console.log(`Sala creada: ${salaId}`);
  });

  // Unirse a sala
  socket.on('UNIRSE_SALA', ({ salaId, equipo, nombre }) => {
    const sala = salas[salaId];
    if (!sala) {
      socket.emit('ERROR', 'Sala no existe');
      return;
    }
    
    if (!['A', 'B'].includes(equipo)) {
      socket.emit('ERROR', 'Equipo debe ser A o B');
      return;
    }

    socket.join(salaId);
    socket.salaId = salaId;
    socket.jugadorId = socket.id;
    socket.nombre = nombre;
    socket.equipo = equipo;
    
    sala.equipos[equipo].push({
      id: socket.id,
      nombre,
      conectado: true
    });
    
    socket.emit('UNIDO_EXITOSO', { 
      salaId, 
      equipo, 
      nombre,
      jugadoresEnEquipo: sala.equipos[equipo].length 
    });
    
    io.to(salaId).emit('JUGADOR_UNIDO', { 
      nombre, 
      equipo, 
      totalA: sala.equipos.A.length,
      totalB: sala.equipos.B.length
    });
    
    console.log(`${nombre} se unió al equipo ${equipo} en sala ${salaId}`);
  });

  // Iniciar juego (solo presentador)
  socket.on('INICIAR_JUEGO', () => {
    const sala = salas[socket.salaId];
    if (!sala || !socket.esPresentador) return;
    
    sala.estado = 'jugando';
    sala.ronda = 1;
    io.to(sala.id).emit('JUEGO_INICIADO', { ronda: 1 });
  });

  // Nueva pregunta
  socket.on('NUEVA_PREGUNTA', () => {
    const sala = salas[socket.salaId];
    if (!sala || !socket.esPresentador) return;
    
    const pregunta = sala.obtenerPreguntaAleatoria();
    if (!pregunta) {
      socket.emit('ERROR', 'No hay más preguntas');
      return;
    }
    
    sala.preguntaActual = pregunta;
    sala.strikes = 0;
    sala.respuestasReveladas = [];
    sala.estado = 'preguntando';
    
    io.to(sala.id).emit('NUEVA_PREGUNTA', {
      pregunta: pregunta.pregunta,
      numRespuestas: pregunta.respuestas.length,
      ronda: sala.ronda
    });
  });

  // Activar buzzers
  socket.on('ACTIVAR_BUZZERS', () => {
    const sala = salas[socket.salaId];
    if (!sala || !socket.esPresentador) return;
    sala.activarBuzzers();
  });

  // Jugador presiona buzzer
  socket.on('BUZZER_PRESSED', () => {
    const sala = salas[socket.salaId];
    if (!sala) return;
    
    const resultado = sala.procesarBuzz(socket.jugadorId, Date.now());
    if (resultado) {
      console.log(`Buzzer ganado por ${socket.nombre}`);
    }
  });

  // Enviar respuesta
  socket.on('RESPUESTA_JUGADOR', ({ respuesta }) => {
    const sala = salas[socket.salaId];
    if (!sala) return;
    
    const resultado = sala.validarRespuesta(respuesta);
    
    if (resultado.correcta) {
      const jugador = sala.encontrarJugador(socket.jugadorId);
      const equipo = jugador ? jugador.equipo : null;
      
      // Si es la primera respuesta correcta y es top, elige jugar o pasar
      if (resultado.esTop && !sala.equipoJugando) {
        sala.equipoJugando = equipo;
        io.to(sala.id).emit('RESPUESTA_TOP', {
          respuesta: resultado.respuesta,
          jugador: socket.nombre,
          equipo,
          mensaje: `${socket.nombre} acertó la respuesta #1`
        });
      } else if (sala.equipoJugando === equipo) {
        // Respuesta correcta del equipo que juega
        sala.revelarRespuesta(resultado.respuesta);
      } else {
        // El otro equipo intenta robar
        sala.revelarRespuesta(resultado.respuesta);
        const puntos = sala.calcularPuntosEnJuego();
        sala.sumarPuntos(equipo, puntos);
        sala.estado = 'esperando';
        io.to(sala.id).emit('ROBO_EXITOSO', { equipo, puntos });
      }
    } else {
      // Respuesta incorrecta
      const jugador = sala.encontrarJugador(socket.jugadorId);
      const equipo = jugador ? jugador.equipo : null;
      
      if (sala.equipoJugando === equipo) {
        sala.agregarStrike();
      }
    }
  });

  // Pasar turno (cuando aciertan la #1)
  socket.on('ELEGIR_JUGAR', ({ jugar }) => {
    const sala = salas[socket.salaId];
    if (!sala) return;
    
    if (jugar) {
      io.to(sala.id).emit('TURNO_ASIGNADO', { 
        equipo: sala.equipoJugando,
        mensaje: `Equipo ${sala.equipoJugando} juega`
      });
    } else {
      const otroEquipo = sala.equipoJugando === 'A' ? 'B' : 'A';
      sala.equipoJugando = otroEquipo;
      io.to(sala.id).emit('TURNO_PASADO', { 
        equipo: otroEquipo,
        mensaje: `Equipo ${otroEquipo} juega`
      });
    }
  });

  // Pasar a siguiente ronda
  socket.on('SIGUIENTE_RONDA', () => {
    const sala = salas[socket.salaId];
    if (!sala || !socket.esPresentador) return;
    
    sala.ronda++;
    if (sala.ronda > 5) {
      io.to(sala.id).emit('JUEGO_TERMINADO', sala.puntos);
      return;
    }
    
    const multiplicador = sala.ronda === 4 ? 2 : (sala.ronda === 5 ? 3 : 1);
    io.to(sala.id).emit('NUEVA_RONDA', { 
      ronda: sala.ronda,
      multiplicador,
      puntosActuales: sala.puntos
    });
  });

  // Dinero Rápido
  socket.on('INICIAR_DINERO_RAPIDO', () => {
    const sala = salas[socket.salaId];
    if (!sala || !socket.esPresentador) return;
    
    // Seleccionar jugador con más puntos o aleatorio
    const jugadores = [...sala.equipos.A, ...sala.equipos.B];
    const jugador = jugadores[Math.floor(Math.random() * jugadores.length)];
    
    sala.estado = 'dinero_rapido';
    
    io.to(sala.id).emit('INICIO_DINERO_RAPIDO', {
      jugador: jugador.nombre,
      tiempoPorPregunta: 20,
      preguntas: preguntas.slice(0, 5).map(p => p.pregunta)
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log('Jugador desconectado:', socket.id);
    const sala = salas[socket.salaId];
    if (sala) {
      for (let eq of ['A', 'B']) {
        sala.equipos[eq] = sala.equipos[eq].filter(j => j.id !== socket.id);
      }
    }
  });
});

// ========== INICIAR SERVIDOR ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Servidor de 100 Latinos Dijeron corriendo en puerto ${PORT}`);
});