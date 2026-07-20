# wasapi-grupo

Herramienta para agregar contactos desde un archivo **Excel** a un **grupo de WhatsApp**, usando [`whatsapp-web.js`](https://wwebjs.dev/).

---

## Requisitos

- Node.js >= 18
- pnpm
- Una cuenta de WhatsApp activa (el número debe ser **administrador del grupo**)

---

## Instalación

```bash
pnpm install
```

Copia el archivo de variables de entorno:

```bash
cp .env.example .env
```

Edita `.env` si necesitas cambiar el puerto o el código de país:

```env
PORT=3030
DEFAULT_COUNTRY_CODE=51   # 51 = Perú
WHATSAPP_SESSION_PATH=./.wwebjs_auth
```

---

## Uso

### 1. Arrancar el servidor

```bash
pnpm start
```

La primera vez aparecerá un **código QR** en la terminal. Escanéalo con tu WhatsApp:  
`WhatsApp → Dispositivos vinculados → Vincular dispositivo`

La sesión se guarda en `.wwebjs_auth/` y no necesitas volver a escanear.

---

### 2. Endpoints disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/status` | Estado de la conexión |
| `GET` | `/qr` | QR actual (si no está conectado) |
| `GET` | `/grupos` | Lista todos tus grupos de WhatsApp |
| `POST` | `/grupos/:groupId/agregar` | Agrega números enviados como JSON |
| `POST` | `/grupos/:groupId/agregar-excel` | **Sube un Excel y agrega los contactos** |
| `POST` | `/grupos/:groupId/inspeccionar-excel` | Previsualiza el Excel antes de agregar |

---

### 3. Flujo típico

#### Paso 1 — Obtener el ID de tu grupo

```http
GET http://localhost:3030/grupos
```

Respuesta:
```json
{
  "grupos": [
    { "id": "51999000111-1234567890@g.us", "name": "Clientes 2024", "participantCount": 45, "isAdmin": true }
  ]
}
```

Copia el `id` del grupo donde quieres agregar contactos.

#### Paso 2 — Preparar el Excel

El Excel puede tener cualquier columna. El sistema **detecta automáticamente** la columna de teléfonos buscando nombres como:  
`telefono`, `teléfono`, `celular`, `phone`, `numero`, `whatsapp`, `movil`

Ejemplo de Excel válido:

| nombre | telefono | email |
|--------|----------|-------|
| Juan Pérez | 51987654321 | juan@mail.com |
| María García | 51912345678 | maria@mail.com |

> Los números deben incluir código de país (`51` para Perú). Si el número tiene solo 9 dígitos, se agrega `51` automáticamente.

#### Paso 3 — Inspeccionar el Excel (opcional)

```http
POST http://localhost:3030/grupos/{groupId}/inspeccionar-excel
Content-Type: multipart/form-data
  file: clientes.xlsx
```

Retorna una preview de los números que se van a agregar.

#### Paso 4 — Agregar desde Excel

```http
POST http://localhost:3030/grupos/{groupId}/agregar-excel
Content-Type: multipart/form-data
  file: clientes.xlsx
  column: telefono    ← (opcional, autodetecta)
```

Respuesta:
```json
{
  "success": true,
  "numeros_leidos": 50,
  "agregados": 47,
  "fallidos": 3,
  "resultados": {
    "agregados": ["51987654321", "51912345678"],
    "fallidos": [
      { "phone": "51911111111", "reason": "privacidad_bloqueada" },
      { "phone": "51922222222", "reason": "ya_es_miembro" }
    ]
  }
}
```

---

### Agregar por JSON (alternativo)

```http
POST http://localhost:3030/grupos/{groupId}/agregar
Content-Type: application/json

{
  "phones": ["51987654321", "51912345678"]
}
```

---

## Razones de fallo al agregar

| Razón | Descripción |
|-------|-------------|
| `ya_es_miembro` | El número ya está en el grupo |
| `privacidad_bloqueada` | El contacto bloqueó que lo agreguen a grupos |
| `no_es_contacto` | El número no tiene cuenta de WhatsApp |
| `numero_invalido` | El número tiene formato incorrecto |
| `error_desconocido` | Error inesperado de WhatsApp |

---

## Estructura del proyecto

```
wasapi-grupo/
├── src/
│   ├── WhatsAppClient.js   ← Sesión de WhatsApp + manejo de grupos
│   ├── excelReader.js      ← Lector de archivos Excel
│   └── server.js           ← Servidor Express con todos los endpoints
├── .env                    ← Variables de entorno (no subir a git)
├── .env.example            ← Plantilla de variables de entorno
├── .gitignore
├── .puppeteerrc.cjs        ← Configuración de Puppeteer
└── package.json
```

---

## Notas importantes

> **Debes ser administrador del grupo** para poder agregar participantes.

> La sesión de WhatsApp se guarda en `.wwebjs_auth/` (no se sube a git). Si borras esta carpeta tendrás que escanear el QR de nuevo.
