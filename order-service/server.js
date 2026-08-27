// Order Service - Empanadas Sinfonía
// Implementa RF-02 (Catálogo + Caché Redis), RF-03 (Pedidos), "Procesar Pago en Línea"
// (Fig. 1), RF-04 (Estado) y publica eventos EDA (sección 4.3)

const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CATALOGO_CACHE_KEY = 'catalogo:cache';
const CATALOGO_CACHE_TTL_SEGUNDOS = 30; // RNF Rendimiento: < 250ms con caché en memoria

let redisClient = null;
(async () => {
  redisClient = redis.createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[Redis] Error:', err.message));
  await redisClient.connect();
  console.log('Order Service conectado a Redis');
})();

async function invalidarCacheCatalogo() {
  if (!redisClient) return;
  try {
    await redisClient.del(CATALOGO_CACHE_KEY);
  } catch (e) {
    console.error('[Redis] No se pudo invalidar la caché del catálogo:', e.message);
  }
}

// ---------- RF-02: Catálogo con caché Redis ----------
app.get('/catalogo', async (req, res) => {
  try {
    if (redisClient) {
      const cacheado = await redisClient.get(CATALOGO_CACHE_KEY);
      if (cacheado) {
        return res.json({ datos: JSON.parse(cacheado), origen: 'cache-redis' });
      }
    }

    const result = await pool.query(
      'SELECT id_tipo, nombre, tipo_masa, precio_unitario, stock FROM tipos_empanada ORDER BY nombre'
    );

    if (redisClient) {
      await redisClient.setEx(CATALOGO_CACHE_KEY, CATALOGO_CACHE_TTL_SEGUNDOS, JSON.stringify(result.rows));
    }

    res.json({ datos: result.rows, origen: 'postgresql' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al consultar el catálogo' });
  }
});

// ---------- RF-03: Registrar un pedido (queda "Pendiente de pago", no publica evento aún) ----------
app.post('/pedidos', async (req, res) => {
  const { items, cliente } = req.body || {};
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'El pedido debe incluir al menos un item' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    const detalles = [];
    for (const item of items) {
      const tipo = await client.query(
        'SELECT precio_unitario, nombre, stock FROM tipos_empanada WHERE id_tipo = $1 FOR UPDATE',
        [item.idTipo]
      );
      if (tipo.rows.length === 0) throw new Error(`Tipo de empanada no encontrado: ${item.idTipo}`);
      if (tipo.rows[0].stock < item.cantidad) {
        throw new Error(`Stock insuficiente para ${tipo.rows[0].nombre}`);
      }
      const subtotal = Number(tipo.rows[0].precio_unitario) * item.cantidad;
      total += subtotal;
      detalles.push({ idTipo: item.idTipo, nombre: tipo.rows[0].nombre, cantidad: item.cantidad, subtotal });
    }

    const pedidoResult = await client.query(
      `INSERT INTO pedidos (cliente, estado, estado_pago, total_pagar)
       VALUES ($1, 'Pendiente de pago', 'Pendiente', $2)
       RETURNING id_pedido, fecha_hora, estado, estado_pago, total_pagar`,
      [cliente || 'anonimo', total]
    );
    const pedido = pedidoResult.rows[0];

    for (const d of detalles) {
      await client.query(
        'INSERT INTO item_pedido (id_pedido, id_tipo, cantidad, subtotal) VALUES ($1, $2, $3, $4)',
        [pedido.id_pedido, d.idTipo, d.cantidad, d.subtotal]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...pedido, items: detalles });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- Caso de uso "Procesar Pago en Línea" (Fig. 1) ----------
// Simula una pasarela de pago. Si se aprueba: descuenta stock, invalida la caché del
// catálogo y publica el evento "PedidoEmpanadasCreado" que despierta al Kitchen Service.
app.post('/pedidos/:id/pago', async (req, res) => {
  const { metodo } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pedidoRes = await client.query(
      'SELECT * FROM pedidos WHERE id_pedido = $1 FOR UPDATE',
      [req.params.id]
    );
    if (pedidoRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    const pedido = pedidoRes.rows[0];
    if (pedido.estado_pago !== 'Pendiente') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Este pedido ya tiene el pago en estado: ${pedido.estado_pago}` });
    }

    // Simulación de la pasarela: 90% de aprobación (usa metodo="fallido" para forzar rechazo de prueba)
    const aprobado = metodo === 'fallido' ? false : Math.random() < 0.9;

    if (!aprobado) {
      const rechazado = await client.query(
        `UPDATE pedidos SET estado = 'Pago Rechazado', estado_pago = 'Rechazado'
         WHERE id_pedido = $1 RETURNING *`,
        [req.params.id]
      );
      await client.query('COMMIT');
      return res.status(402).json({ ...rechazado.rows[0], mensaje: 'El pago fue rechazado por la pasarela. Intenta de nuevo.' });
    }

    const items = await client.query('SELECT id_tipo, cantidad FROM item_pedido WHERE id_pedido = $1', [req.params.id]);
    for (const item of items.rows) {
      await client.query('UPDATE tipos_empanada SET stock = stock - $1 WHERE id_tipo = $2', [item.cantidad, item.id_tipo]);
    }

    const aprobadoRes = await client.query(
      `UPDATE pedidos SET estado = 'En cocina', estado_pago = 'Aprobado'
       WHERE id_pedido = $1 RETURNING *`,
      [req.params.id]
    );

    await client.query('COMMIT');
    await invalidarCacheCatalogo();

    const detalles = await pool.query(
      `SELECT ip.cantidad, ip.subtotal, te.nombre
       FROM item_pedido ip JOIN tipos_empanada te ON te.id_tipo = ip.id_tipo
       WHERE ip.id_pedido = $1`,
      [req.params.id]
    );

    const evento = {
      tipo: 'PedidoEmpanadasCreado',
      idPedido: Number(req.params.id),
      items: detalles.rows,
      total: aprobadoRes.rows[0].total_pagar,
      fecha: aprobadoRes.rows[0].fecha_hora,
    };
    if (redisClient) await redisClient.publish('pedidos-empanadas', JSON.stringify(evento));

    res.json({ ...aprobadoRes.rows[0], mensaje: 'Pago aprobado. El pedido pasó a cocina.' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Error al procesar el pago' });
  } finally {
    client.release();
  }
});

// ---------- Listado de pedidos (para las vistas por rol: cocina, domiciliario, cliente) ----------
app.get('/pedidos', async (req, res) => {
  const { estado, cliente } = req.query;
  const condiciones = [];
  const params = [];

  if (estado) {
    params.push(estado);
    condiciones.push(`p.estado = $${params.length}`);
  }
  if (cliente) {
    params.push(cliente);
    condiciones.push(`p.cliente = $${params.length}`);
  }

  const whereClause = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT p.*,
              COALESCE(
                json_agg(json_build_object('nombre', te.nombre, 'cantidad', ip.cantidad))
                FILTER (WHERE ip.id_item IS NOT NULL), '[]'
              ) AS items
       FROM pedidos p
       LEFT JOIN item_pedido ip ON ip.id_pedido = p.id_pedido
       LEFT JOIN tipos_empanada te ON te.id_tipo = ip.id_tipo
       ${whereClause}
       GROUP BY p.id_pedido
       ORDER BY p.fecha_hora DESC
       LIMIT 50`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al listar los pedidos' });
  }
});

// ---------- RF-04: Consultar el estado de un pedido ----------
app.get('/pedidos/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pedidos WHERE id_pedido = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error al consultar el pedido' });
  }
});

// ---------- RF-04: Actualizar estado (usado por Kitchen Service / repartidores) ----------
app.patch('/pedidos/:id/estado', async (req, res) => {
  const { estado } = req.body || {};
  const validos = ['En cocina', 'Despachado', 'Entregado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const result = await pool.query(
      'UPDATE pedidos SET estado = $1 WHERE id_pedido = $2 RETURNING *',
      [estado, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));

app.listen(PORT, () => console.log(`Order Service escuchando en el puerto ${PORT}`));
