# WhatsApp Bot con OpenAI

Bot de WhatsApp con IA que incluye dashboard para control manual de conversaciones.

## ¿Qué hace?

- ✅ Responde automáticamente con OpenAI a mensajes de WhatsApp
- ✅ Dashboard para ver todas las conversaciones
- ✅ Pausar/reanudar el bot por conversación
- ✅ Escribir mensajes manualmente desde el dashboard
- ✅ Guardar historial de conversaciones en SQLite
- ✅ Reportes básicos (total de mensajes, conversaciones, etc.)

## Instalación

1. **Clonar/crear proyecto**
```bash
cd ~/Documents/GitHub/whatsapp-bot
```

2. **Crear archivo `.env`**
Copia de `.env.example` y completa con tus credenciales:
```bash
cp .env.example .env
```

3. **Llenar variables en `.env`:**
   - `OPENAI_API_KEY`: Tu API key de OpenAI (obtén en https://platform.openai.com)
   - `WHATSAPP_PHONE_ID`: Tu número (3012443501)
   - `WHATSAPP_ACCESS_TOKEN`: Token de Meta (ver pasos abajo)
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`: ID de cuenta de Meta
   - `VERIFY_TOKEN`: Token para webhooks (cualquier string aleatorio)

## Obtener credenciales de WhatsApp Business

### 1. Crear App en Meta
- Ir a https://developers.facebook.com/
- Crear nueva app → Tipo: Business
- Añadir producto "WhatsApp"

### 2. Obtener Token de Acceso
- En Dashboard de la app → WhatsApp → Configuración
- Generar token temporal (válido 24h)
- Copiar en `.env` como `WHATSAPP_ACCESS_TOKEN`

### 3. Obtener Business Account ID
- En Configuración → IDs de cuenta
- Copiar en `.env` como `WHATSAPP_BUSINESS_ACCOUNT_ID`

### 4. Configurar Webhook
- En WhatsApp → Configuración → Webhooks
- **Callback URL**: `https://tudominio.com/webhook`
- **Verify Token**: El que pusiste en `.env`

## Correr el bot

```bash
npm start
```

El servidor estará en: `http://localhost:3000`

## Dashboard

Accede a `http://localhost:3000` y verás:
- Lista de conversaciones en la izquierda
- Historial de mensajes al centro
- Botones para pausar/reanudar el bot
- Caja de entrada para escribir mensajes manualmente

## Hostear en Producción

Para ponerlo online (Railway, Render, etc.):

1. **Railway** (recomendado):
   ```bash
   npm install -g railway
   railway login
   railway init
   railway up
   ```

2. **Render**:
   - Conectar repo de GitHub
   - Build command: `npm install`
   - Start command: `npm start`
   - Agregar variables de entorno

3. **Heroku** (gratis ya no existe):
   ```bash
   heroku create tu-app-nombre
   heroku config:set OPENAI_API_KEY=sk-...
   git push heroku main
   ```

## Base de Datos

Los datos se guardan en `bot.db` (SQLite). Contiene:
- **conversations**: Conversaciones activas (teléfono, estado, si está pausado)
- **messages**: Todos los mensajes (remitente, contenido, timestamp)
- **scheduled**: Mensajes programados (agendar para después)

## Costos Estimados

- **OpenAI**: ~$0.15-0.30 por 1000 mensajes (con GPT-4o mini)
- **Hosting**: $5-10/mes en Railway o Render
- **WhatsApp**: Primeros 1000 mensajes gratis, luego $0.004-0.005/msg
- **Total**: ~$5-15/mes para 1000 mensajes/mes

## Próximos pasos

- [ ] Agregar autenticación al dashboard
- [ ] Agendar mensajes automáticos
- [ ] Exportar reportes en PDF
- [ ] Integrar pagos
- [ ] Soporte para múltiples números

## Troubleshooting

**"Cannot find module 'better-sqlite3'"**
```bash
npm install better-sqlite3
```

**Webhook no recibe mensajes**
- Verificar que el `VERIFY_TOKEN` es correcto
- Asegurar que la URL es pública (https, no http)
- Probar en Test de webhooks en Meta

**OpenAI devuelve error**
- Verificar que el API key es válido
- Checar que tienes crédito en la cuenta
