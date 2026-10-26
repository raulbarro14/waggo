# Waggo

App para organizar quién saca a los perros: rutinas semanales, cambios de un día, paseos puntuales y "hecho". Se instala en el móvil y en el ordenador como una app (PWA), funciona sin conexión y se sincroniza entre todos los de casa.

- **Datos:** Firebase Firestore (plan gratuito Spark, sin tarjeta).
- **Entrada:** con cuenta de Google. Solo entran los correos que tú autorices.
- **Alojamiento:** GitHub Pages (gratis).

## 1. Crear el proyecto de Firebase

1. Entra en <https://console.firebase.google.com> y pulsa **Crear un proyecto**. Ponle un nombre (por ejemplo `turnos-paseo`). Google Analytics no hace falta.
2. En la página del proyecto, pulsa el icono **Web** (`</>`) para añadir una app web. Ponle un apodo y **no** marques Firebase Hosting.
3. Te enseña un bloque `const firebaseConfig = { ... }`. Copia esos valores en [`firebase-config.js`](firebase-config.js), sustituyendo los del ejemplo.

   Estos valores no son secretos y se pueden subir a GitHub: lo que protege tus datos son las reglas del paso 3.

## 2. Activar el inicio de sesión con Google

1. Menú **Compilación → Authentication → Comenzar**.
2. En **Método de inicio de sesión**, elige **Google**, actívalo, pon tu correo de asistencia y guarda.
3. En **Configuración → Dominios autorizados**, añade `raulbarro14.github.io` (el dominio de GitHub Pages). `localhost` ya viene incluido para probar en tu ordenador.

## 3. Crear la base de datos y sus reglas

1. Menú **Compilación → Firestore Database → Crear base de datos**.
2. Elige una ubicación cercana (por ejemplo `europe-southwest1`, Madrid) y empieza en **modo de producción**.
3. Pestaña **Reglas**: borra lo que haya, pega el contenido de [`firestore.rules`](firestore.rules) y pulsa **Publicar**.

## 4. Decir quién puede entrar

En la pestaña **Datos** de Firestore:

1. **Iniciar colección** → ID de colección: `access`.
2. ID del documento: `members`.
3. Añade dos campos de tipo **array**:
   - `editors`: un elemento de tipo string por cada persona que puede editar. Empieza por tu correo.
   - `viewers`: los que solo pueden mirar. Puede quedar vacío.

Escribe los correos **en minúsculas**. Para añadir a alguien más adelante, edita este documento. No hace falta tocar la app.

## 5. Publicar en GitHub Pages

1. Crea un repositorio nuevo en GitHub (por ejemplo `turnos-paseo`) y sube el contenido de esta carpeta a la rama `main`.
2. En el repositorio: **Settings → Pages → Build and deployment**. En *Source* elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`, y guarda.
3. En un minuto la app estará en `https://raulbarro14.github.io/turnos-paseo/`.

## 6. Instalarla

- **Android (Chrome):** abre la dirección y pulsa **Instalar app** (o menú ⋮ → *Instalar aplicación*).
- **iPhone (Safari):** abre la dirección, pulsa **Compartir** → **Añadir a pantalla de inicio**.
- **Ordenador (Chrome o Edge):** pulsa el icono de instalar que aparece a la derecha de la barra de direcciones.

La primera vez entra con tu cuenta de Google. Después se abre como cualquier otra app, también sin conexión: lo que cambies sin internet se envía al recuperarla.

## Probarla en tu ordenador

El inicio de sesión y el modo sin conexión necesitan servir la carpeta por `http://localhost`, no abrir el archivo con doble clic. Con Python instalado:

```bash
python -m http.server 8000
```

y abre <http://localhost:8000>.

## Actualizar la app

Sube los cambios a GitHub. La app instalada carga la versión nueva la próxima vez que se abre con conexión. Si añades archivos nuevos, añádelos también a la lista `SHELL` de [`sw.js`](sw.js) y sube el número de `CACHE`.

## Archivos

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` | Pantallas y estilos |
| `app.js` | Lógica de la app (calendario, rutinas, formularios) |
| `backend.js` | Conexión con Firebase (entrada con Google y base de datos) |
| `firebase-config.js` | La configuración de tu proyecto de Firebase |
| `firestore.rules` | Quién puede leer y escribir |
| `manifest.webmanifest`, `icons/` | Lo que la hace instalable (nombre, colores, icono) |
| `sw.js` | Guarda la app para que abra sin conexión |
