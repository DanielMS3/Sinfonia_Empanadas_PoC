// API Gateway - Empanadas Sinfonía
// Implementa RF-01 (Auth JWT), RF-05 (Gateway) y el patrón Circuit Breaker (RNF Disponibilidad)

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const CircuitBreaker = require('opossum');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:4000';
const JWT_SECRET = process.env.JWT_SECRET || 'sinfonia-secret-demo';

// ---------- RF-01: Autenticación (usuarios de demo) ----------
const USERS_DEMO = [
  { username: 'cliente1', password: '1234', role: 'cliente' },
  { username: 'cocina1', password: '1234', role: 'cocina' },
  { username: 'domiciliario1', password: '1234', role: 'domiciliario' },
];

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS_DEMO.find((u) => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ token, role: user.role });
});

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Token inválido o expirado' });
  }
}

// ---------- Circuit Breaker (Opossum) hacia el Order Service ----------
async function callOrderService(method, path, data) {
  const resp = await axios({ method, url: `${ORDER_SERVICE_URL}${path}`, data, timeout: 3000 });
  return resp.data;
}

const breaker = new CircuitBreaker(callOrderService, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
});

// Fallback descrito en el informe (sección 4.2)
breaker.fallback(() => ({
  fallback: true,
  mensaje: 'El catálogo de empanadas está en reabastecimiento momentáneo. Intenta de nuevo en unos segundos.',
}));

breaker.on('open', () => console.log('[CircuitBreaker] ABIERTO - Order Service no responde'));
breaker.on('halfOpen', () => console.log('[CircuitBreaker] MEDIO ABIERTO - probando Order Service'));
breaker.on('close', () => console.log('[CircuitBreaker] CERRADO - Order Service recuperado'));

// ---------- RF-02: Consulta de catálogo ----------
app.get('/api/catalogo', async (req, res) => {
  const data = await breaker.fire('get', '/catalogo');
  res.json(data);
});

// ---------- RF-03: Registro de pedidos ----------
app.post('/api/pedidos', verifyToken, async (req, res) => {
  if (req.user.role !== 'cliente') {
    return res.status(403).json({ error: 'Solo los clientes pueden crear pedidos' });
  }
  const data = await breaker.fire('post', '/pedidos', { ...req.body, cliente: req.user.username });
  res.status(data.fallback ? 503 : 201).json(data);
});

// ---------- Caso de uso "Procesar Pago en Línea" ----------
app.post('/api/pedidos/:id/pago', verifyToken, async (req, res) => {
  if (req.user.role !== 'cliente') {
    return res.status(403).json({ error: 'Solo los clientes pueden procesar el pago de su pedido' });
  }
  const data = await breaker.fire('post', `/pedidos/${req.params.id}/pago`, req.body);
  res.status(data.fallback ? 503 : data.estado_pago === 'Rechazado' ? 402 : 200).json(data);
});

// ---------- Listado de pedidos por rol (Cliente ve los suyos; Cocina/Domiciliario ven por estado) ----------
app.get('/api/pedidos', verifyToken, async (req, res) => {
  const params = new URLSearchParams();
  if (req.user.role === 'cliente') {
    params.set('cliente', req.user.username);
  } else if (req.query.estado) {
    params.set('estado', req.query.estado);
  }
  const data = await breaker.fire('get', `/pedidos?${params.toString()}`);
  res.json(data);
});

// ---------- RF-04: Seguimiento y actualización de estado ----------
app.get('/api/pedidos/:id', verifyToken, async (req, res) => {
  const data = await breaker.fire('get', `/pedidos/${req.params.id}`);
  res.json(data);
});

app.patch('/api/pedidos/:id/estado', verifyToken, async (req, res) => {
  if (!['cocina', 'domiciliario'].includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado para actualizar el estado del pedido' });
  }
  const data = await breaker.fire('patch', `/pedidos/${req.params.id}/estado`, req.body);
  res.json(data);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.listen(PORT, () => console.log(`API Gateway escuchando en el puerto ${PORT}`));
