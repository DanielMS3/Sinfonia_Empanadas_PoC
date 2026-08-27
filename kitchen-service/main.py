# Kitchen Service - Empanadas Sinfonía
# Implementa la Event-Driven Architecture (sección 4.3): consume eventos de Redis Pub/Sub,
# "prepara" el pedido y luego notifica al Order Service para actualizar el estado (RF-04).

import asyncio
import json
import os
import random

import httpx
import redis.asyncio as redis
from fastapi import FastAPI

app = FastAPI(title="Kitchen Service - Empanadas Sinfonía")

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
ORDER_SERVICE_URL = os.getenv("ORDER_SERVICE_URL", "http://order-service:4000")
CHANNEL = "pedidos-empanadas"

pedidos_en_preparacion: dict = {}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "kitchen-service"}


@app.get("/pedidos-activos")
async def pedidos_activos():
    """Vista en memoria de los pedidos que la cocina está procesando (demo)."""
    return pedidos_en_preparacion


async def procesar_pedido(evento: dict):
    id_pedido = evento["idPedido"]
    pedidos_en_preparacion[id_pedido] = {"estado": "En cocina", "items": evento["items"]}
    print(f"[Cocina] Nuevo pedido #{id_pedido} recibido: {evento['items']}")

    # Simula el tiempo de preparación de las empanadas
    tiempo_preparacion = random.randint(4, 8)
    await asyncio.sleep(tiempo_preparacion)

    async with httpx.AsyncClient() as client:
        try:
            await client.patch(
                f"{ORDER_SERVICE_URL}/pedidos/{id_pedido}/estado",
                json={"estado": "Despachado"},
                timeout=5,
            )
            pedidos_en_preparacion[id_pedido]["estado"] = "Despachado"
            print(f"[Cocina] Pedido #{id_pedido} despachado hacia el domiciliario")
        except httpx.HTTPError as exc:
            print(f"[Cocina] Error al actualizar el pedido #{id_pedido}: {exc}")


async def escuchar_eventos():
    cliente_redis = redis.from_url(REDIS_URL, decode_responses=True)
    pubsub = cliente_redis.pubsub()
    await pubsub.subscribe(CHANNEL)
    print(f"[Cocina] Suscrito al canal '{CHANNEL}', esperando pedidos...")

    async for mensaje in pubsub.listen():
        if mensaje["type"] != "message":
            continue
        try:
            evento = json.loads(mensaje["data"])
            if evento.get("tipo") == "PedidoEmpanadasCreado":
                asyncio.create_task(procesar_pedido(evento))
        except (json.JSONDecodeError, KeyError) as exc:
            print(f"[Cocina] Evento inválido recibido: {exc}")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(escuchar_eventos())
