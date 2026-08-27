-- Empanadas Sinfonía - Esquema de Base de Datos
-- Corresponde al Diagrama de Clases del Dominio (Fig. 2 del informe)

CREATE TABLE IF NOT EXISTS tipos_empanada (
    id_tipo         SERIAL PRIMARY KEY,
    nombre          VARCHAR(80) NOT NULL,
    tipo_masa       VARCHAR(60) NOT NULL,
    precio_unitario NUMERIC(10, 2) NOT NULL,
    stock           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pedidos (
    id_pedido    SERIAL PRIMARY KEY,
    cliente      VARCHAR(80) NOT NULL,
    fecha_hora   TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Pendiente de pago | En cocina | Despachado | Entregado | Pago Rechazado
    estado       VARCHAR(20) NOT NULL DEFAULT 'Pendiente de pago',
    -- Pendiente | Aprobado | Rechazado (caso de uso "Procesar Pago en Línea")
    estado_pago  VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
    total_pagar  NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_pedido (
    id_item     SERIAL PRIMARY KEY,
    id_pedido   INTEGER NOT NULL REFERENCES pedidos(id_pedido) ON DELETE CASCADE,
    id_tipo     INTEGER NOT NULL REFERENCES tipos_empanada(id_tipo),
    cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
    subtotal    NUMERIC(10, 2) NOT NULL
);

-- Datos semilla: variedades mencionadas en el informe
INSERT INTO tipos_empanada (nombre, tipo_masa, precio_unitario, stock) VALUES
    ('Empanada de Pipián',       'Maíz amarillo', 3500, 50),
    ('Empanada Salteña',         'Trigo dulce',   4200, 40),
    ('Empanada de Pino Chileno', 'Trigo horneado',4500, 35),
    ('Empanada Costeña de Queso','Maíz blanco',   3000, 60),
    ('Catibía de Yuca',          'Yuca',          3800, 30)
ON CONFLICT DO NOTHING;
