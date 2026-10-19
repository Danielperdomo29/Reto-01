# Reto 01 — Agente Conversacional "Registro como Proveedor"

Solución de nivel senior en TypeScript para automatizar la lectura de solicitudes de clientes, mapeo de campos contra el repositorio maestro, generación de formularios (`.xlsx`, `.pdf`, `.portal`) y armado del paquete para firma con confirmación humana (HITL), cumpliendo las reglas RN1 a RN5 del PRD.

## Requisitos Previos
- **Node.js** (`>= 20.0`) o **Bun** (`>= 1.1`).

## 1. Instalación y Arranque en Local (Un solo comando)
1. Copia las variables de entorno de ejemplo y agrega tu clave de API (`OPENROUTER_API_KEY`, `GEMINI_API_KEY` u `OPENAI_API_KEY`):
   ```bash
   cp .env.example .env
   ```
   *(Por defecto utiliza OpenRouter con el modelo gratuito verificado `nvidia/nemotron-3-ultra-550b-a55b:free` (respaldo automatico: `nvidia/nemotron-3-super-120b-a12b:free` y `google/gemma-4-31b-it:free`).*

2. Instala dependencias y levanta el servidor (Frontend y Backend unificados en el puerto 3000):
   ```bash
   # Con Node 20+ / npm:
   npm install && npm run dev

   # O con Bun:
   bun install && bun run dev
   ```

3. Abre en el navegador: [http://localhost:3000](http://localhost:3000)

## 2. Ejecución de demo.ts (Verificación determinista sin LLM)
Ejecuta todos los casos de prueba (`fixtures/reto-01/casos/`) llamando directamente a las herramientas tipadas sin consumir saldo ni requerir claves de API:

```bash
# Con Node 20+ / npm:
npm run demo

# O con Bun:
bun run demo.ts
```

## 3. Endpoints de la API HTTP
- `POST /api/chat` — Recibe `{ sessionId, message }` y ejecuta el ciclo acotado del agente. Devuelve `{ ok, reply, toolCalls[], needsConfirmation }`.
- `GET /api/sessions/:id` — Devuelve el historial completo de mensajes y llamadas a herramientas de la sesión.
- `GET /api/health` — Devuelve `{ ok: true, provider, model }` sin exponer claves ni datos sensibles.

## 4. Módulo Reutilizable (`modulo/`)
Se incluye el paquete desacoplado `modulo/` con las mismas herramientas y el conocimiento del proceso, listo para integrarse a otras plataformas de agentes:
- `modulo/agent.md` (frontmatter: description, mode: primary, permission {edit: deny, bash: deny})
- `modulo/skill/registro-proveedor/SKILL.md` (conocimiento normativo y reglas de negocio RN1-RN5)
- `modulo/tools/proveedor.ts` (re-exportación directa sin duplicación de código)

## 5. Enlaces Públicos y Despliegue en Producción
- **Aplicación Web en Producción (Fullstack Node.js + API + Frontend):**
  [https://reto-01-registro-proveedor-3vat.onrender.com](https://reto-01-registro-proveedor-3vat.onrender.com)
- **Frontend de Respaldo / Redirección CI/CD en Netlify:**
  [https://reto0.netlify.app](https://reto0.netlify.app) (redirige 301 permanentemente al servicio activo en Render).
- **Túnel Alternativo HTTPS Local:**
  ```bash
  npx cloudflared tunnel --url http://localhost:3000
  ```
