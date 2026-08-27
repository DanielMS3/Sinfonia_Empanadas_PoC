# Empanadas Sinfonía — Prototipo MVP

Implementación funcional de la arquitectura descrita en *"Orquestando Códigos: La Sinfonía
de los Sistemas"*: microservicios orientados a eventos, con **API Gateway + Circuit
Breaker (Opossum)**, **Order Service** (Node/Express + PostgreSQL) y **Kitchen Service**
(FastAPI + Redis Pub/Sub). Localmente se ejecuta con Docker Compose; en producción se
despliega gratis en **Render.com** + **Upstash Redis**, tal como plantea el informe.

## Arquitectura

```
Cliente Web/Móvil ──▶ API Gateway (Node + Opossum) ──▶ Order Service (Express + Postgres)
                                                              │
                                                    publica evento a
                                                              ▼
                                                     Redis Pub/Sub (canal: pedidos-empanadas)
                                                              │
                                                              ▼
                                                     Kitchen Service (FastAPI)
                                                     "prepara" y actualiza estado
```

## Requisitos

- Docker y Docker Compose

## Cómo ejecutar

```bash
cd empanadas-sinfonia
docker compose up --build
```

Servicios expuestos:
- API Gateway: `http://localhost:3000`
- Order Service (uso interno del gateway): `http://localhost:4000`
- Kitchen Service: `http://localhost:5000`
- PostgreSQL: `localhost:5432` (usuario/clave: `sinfonia`/`sinfonia`)
- Redis: `localhost:6379`

## Flujo de prueba (equivale al Diagrama de Secuencia, Fig. 3)

**1. Login (RF-01)**

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"cliente1","password":"1234"}'
```

Copia el `token` de la respuesta.

**2. Consultar catálogo (RF-02)**

```bash
curl http://localhost:3000/api/catalogo
```

**3. Crear un pedido (RF-03) — 3x Pipián, 2x Salteña**

```bash
curl -X POST http://localhost:3000/api/pedidos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"items":[{"idTipo":1,"cantidad":3},{"idTipo":2,"cantidad":2}]}'
```

El pedido queda en estado `Pendiente de pago` y **todavía no** se descuenta stock ni se publica el evento a Redis.

**4. Procesar el pago (caso de uso "Procesar Pago en Línea", Fig. 1)**

```bash
curl -X POST http://localhost:3000/api/pedidos/1/pago \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{}'
```

Simula una pasarela de pago (90% de probabilidad de aprobación). Si se aprueba: descuenta el
stock, invalida la caché del catálogo y **ahí sí** publica `PedidoEmpanadasCreado` en Redis,
pasando el pedido a `En cocina`. Para forzar un rechazo de prueba, envía `{"metodo":"fallido"}`.

**5. Seguimiento del pedido (RF-04)**

```bash
curl http://localhost:3000/api/pedidos/1 \
  -H "Authorization: Bearer TU_TOKEN"
```

El Kitchen Service simula la preparación (4-8 s) y cambia el estado automáticamente
a `Despachado`; puedes ver los logs con `docker compose logs -f kitchen-service`.

## Panel visual con vistas por rol

Abre `panel.html` directamente en el navegador (doble clic) mientras `docker compose up`
está corriendo. Al iniciar sesión, cada rol entra a una pantalla distinta:

- **Cliente**: catálogo, carrito, pago simulado y seguimiento de "Mis pedidos".
- **Cocina**: tablero de solo lectura con los pedidos en `En cocina` (join con sus items).
- **Domiciliario**: lista de pedidos `Despachado` con botón para marcarlos `Entregado`.

Esto usa el nuevo endpoint `GET /api/pedidos` (filtrado por `cliente` para el rol cliente,
o por `?estado=` para cocina/domiciliario), separado del existente `GET /api/pedidos/:id`.

## Caché Redis en el catálogo (RNF Rendimiento)

`GET /api/catalogo` responde `{"datos": [...], "origen": "postgresql" | "cache-redis"}`.
La primera consulta llega a PostgreSQL y queda en caché por 30 segundos; las siguientes,
dentro de ese lapso, responden directamente desde Redis (`origen: "cache-redis"`), sosteniendo
el SLA de <250ms del Cuadro 2. La caché se invalida automáticamente cada vez que se aprueba
un pago y cambia el stock.

## Reiniciar la base de datos tras esta actualización

El esquema cambió (se agregó la columna `estado_pago`). Si ya habías levantado el proyecto
antes, borra el volumen de Postgres para que `init.sql` se vuelva a ejecutar:

```bash
docker compose down -v
docker compose up --build
```

## Probar el Circuit Breaker (sección 4.2)

```bash
docker compose stop order-service
curl http://localhost:3000/api/catalogo
```

En vez de un error 500, el Gateway responde con el mensaje de fallback ("catálogo en
reabastecimiento momentáneo"). Al volver a levantar `order-service`, el disyuntor pasa a
medio-abierto y luego se cierra de nuevo automáticamente.

## Usuarios de demo

| Usuario          | Password | Rol           |
|------------------|----------|---------------|
| cliente1         | 1234     | cliente       |
| cocina1          | 1234     | cocina        |
| domiciliario1    | 1234     | domiciliario  |

## Despliegue gratuito en la nube (como en el informe)

- **Render.com (Free Web Services)**: crea un servicio por cada carpeta (`gateway`,
  `order-service`, `kitchen-service`) apuntando a su `Dockerfile`, y una base de datos
  PostgreSQL gratuita de Render para `DATABASE_URL`.
- **Upstash Redis (Free Tier)**: crea una base y usa la URL con TLS (`rediss://...`) como
  `REDIS_URL` en `order-service` y `kitchen-service`.
- Ajusta las variables de entorno (`ORDER_SERVICE_URL`, `JWT_SECRET`, etc.) en el panel de
  cada servicio de Render con las URLs públicas asignadas.

## Estructura del proyecto

```
empanadas-sinfonia/
├── docker-compose.yml
├── db/init.sql                # Esquema + datos semilla (tipos de empanada)
├── gateway/                   # API Gateway + Circuit Breaker + JWT
├── order-service/             # Catálogo, pedidos, publica eventos
└── kitchen-service/           # Consume eventos, simula cocina, actualiza estado
```
