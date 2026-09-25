# Impresión con PIN — Pantum BM5220ADW

App PEDK que corre **dentro de la impresora**. Nadie imprime, fotocopia ni escanea sin
identificarse en el panel con **usuario y PIN**, y se cuenta lo que hace cada persona.
Además se **copia y se escanea desde la propia app**, sin salir al menú del equipo. No
necesita servidor ni internet: usuarios, contadores y ajustes viven en la memoria del
equipo, y se administra desde un **panel web que sirve la propia impresora**.

## Manuales

Este README es para quien toca el código. Para usar y entregar la app:

| Documento | Para quién |
|---|---|
| [`doc/manual-usuario.md`](doc/manual-usuario.md) | Una hoja para pegar junto a la impresora |
| [`doc/manual-administrador.md`](doc/manual-administrador.md) | Quien gestiona usuarios, destinos, contadores y respaldos |
| [`doc/instalacion-y-entrega.md`](doc/instalacion-y-entrega.md) | Quien instala en casa del cliente, con prueba de aceptación |

Los tres están además en **PDF listo para imprimir** en [`doc/pdf/`](doc/pdf). Para
regenerarlos tras cambiar un manual (usa el Chrome que ya está instalado, sin añadir
dependencias):

```
node herramientas/hacer-manuales.mjs
```

Proyecto independiente de `CloudPrint` y de `SoprintPantum5220`. Reutiliza lo que ya se
comprobó en este equipo con esas dos apps (dibujo del panel, salida al menú, lectura del
historial, reposo), pero no comparte código ni se instala junto a ellas.

## Cómo funciona

**Modo retención (el que se usa, comprobado en el equipo el 16-09-2026)**

```
PC: driver "Impresión segura"          la persona entra con su usuario + PIN
    Nombre = usuario, Contraseña = PIN │   (la app la valida)
                     │                 ▼
   el equipo lo guarda ──> queda en cola ──> la app lista SUS documentos ──> Imprimir
                                                                                │
                          se le cuenta a esa persona en el historial  <────────┘
```

Nadie imprime sin usuario y contraseña. Una **impresión normal** (sin contraseña) la
**cancela el guardián** (`vigia.js`) antes de que salga papel. Los trabajos seguros de
otras personas simplemente **esperan en cola** a que cada quien entre con su PIN.

Cómo la app distingue qué cancelar, medido en el equipo: al llegar, un trabajo seguro
guardándose trae el nombre **entre comillas** (`"t"`); una impresión normal trae el
título real del archivo, sin comillas. El guardián deja pasar lo entrecomillado y lo que
la propia app acaba de liberar (ventana de liberación), y cancela el resto.

En modo retención el interruptor `FUNC_T_NET_PRINT` **no** se apaga (apagarlo cortaría
también la impresión segura): la impresión de red queda abierta y el guardián es quien
obliga a usar el PIN. Se activa con **Ajustes → Bloqueo: ENCENDIDO**.

**Fotocopias con PIN** (Ajustes → Copia: con PIN): sin nadie dentro, la copia, la copia
de DNI y la de facturas están apagadas. Al entrar se encienden y la sesión ofrece
**Copiar**, una pantalla propia (`src/copia.js`, `pedk.jobs.copy`) con el número de
copias: la persona no sale de la app. Queda el botón **Menú del equipo** para lo demás.
Al pulsar **Terminar** (o al caducar la sesión) se vuelven a apagar.

Este firmware **no deja elegir el origen** (cristal o alimentador): `COPY_SCAN_SOURCE`
lanza `EOPNOTSUPP`, así que ese botón sólo aparece si algún día lo acepta. El equipo
decide solo: alimentador si hay hojas, si no el cristal.

**Escaneo con PIN** (Ajustes → Escaneo: con PIN): apaga `PUSH_SCAN`, `PULL_SCAN` y los
destinos `SCAN_TO_*` fuera de sesión — también bloquea el Asistente de Escaneado que se
usa desde un PC. Con sesión, la pantalla **Escanear** (`src/escaneo.js`,
`pedk.jobs.scan`) manda a **memoria USB, la carpeta de esa persona o su correo**, en PDF
o JPEG y en B/N, grises o color. El destino viaja DENTRO del trabajo
(`AddressBookParam`), así que no hay que dar de alta a nadie en la libreta del equipo.
Hay que llamar a `finish()` para cerrar el documento: el equipo se queda esperando más
hojas hasta que se le dice que acabó.

**Lo que el equipo cuenta por su cuenta** (`src/estados.js`): la app escucha
`pedk.device.status` y traduce sus avisos — esperando la hoja siguiente, guardando,
correo enviado o **no** enviado, sin hojas, tapa abierta, atasco, sin memoria USB. Sin
eso, un envío fallido se veía en pantalla como "Listo", porque el trabajo termina bien
igualmente.

**Modo sesión (alternativo, no recomendado)**: el equipo se desbloquea al entrar y se
bloquea al salir, con la cerradura de interruptores. No sirve para "sólo con PIN" porque
apagar la impresión de red bloquea también la impresión segura.

## Panel web

La impresora sirve la administración en:

```
http://<IP de la impresora>/pedk/app_notify/impresion
```

El tramo `/pedk/app_notify/` lo pone el firmware y no se puede quitar; lo que sigue es el
`name` del `package.json` (debe coincidir con `config.WEB_APP`). Hay un acceso directo en
`herramientas/Impresión con PIN.url` (cambiar la IP si hace falta). **Conviene reservar
la IP de la impresora en el router**: si cambia, la dirección deja de funcionar.

Se entra con el **PIN de administrador**, el mismo del panel (de fábrica `2580`). Tras 5
fallos se frena 5 minutos; la sesión caduca a los 15 minutos sin uso.

| Sección | Qué hace |
|---|---|
| **Usuarios** | Todos en una página con **Editar · Desactivar · Borrar**. Cada usuario puede llevar **nombre completo** (opcional). La ficha cambia PIN y nombre |
| **Importar Excel** | Plantilla `.xlsx`, vista previa fila a fila y alta de los válidos (ver abajo) |
| **Contadores** | Todos los usuarios (también los que no imprimieron), "Sin identificar" y usuarios borrados. Filas alternas y cifras alineadas. **CSV para Excel** y puesta a cero |
| **Ajustes** | Modo, bloqueo, copia con PIN, duración de la sesión, desbloquear equipo, **PIN de administrador**. Misma lógica que el panel (`acciones.js`); no cambia el modo ni enciende el bloqueo con alguien dentro |
| **Copia de seguridad** | **Descargar** y **Subir** desde el navegador. Los respaldos los hace el propio administrador |

**Límites del firmware y cómo se esquivan** (medidos el 21-09-2026):

- Una respuesta de más de **1998 bytes** no sale (página en blanco) y con ~4 KB la web se
  cuelga hasta reiniciar. Toda respuesta queda por debajo de `WEB_MAX_BYTES` (1900): la
  lista de usuarios, el CSV, la copia, la plantilla y los scripts grandes van **por
  partes** (`SIGUIENTE;n`), y el navegador los junta. Los scripts se cargan con
  `cargador()` y la ruta `/js`.
- Lo que la impresora **recibe** aguanta mucho menos: un POST de 1002 bytes **cuelga la
  web** hasta reiniciar (502 llegan). Las subidas van en trozos de 240 caracteres en
  base64url, **comprimidas** por el navegador (deflate) y descomprimidas en la impresora
  con `src/inflate.js`, porque su motor no trae zlib.
- Dibujar el panel trae la app al frente: tras "Ir a copiar" no se dibuja nada hasta que
  la persona vuelve (`router.salioDeLaApp`).
- La web va por **HTTP sin cifrar**: en la red de la oficina el PIN viaja en claro.

**Diseño**: colores y paneles de la web de Pantum del equipo (rojo `#BB0033`, cabeceras
rojas, borde gris), sin su logotipo. Responsive: en el móvil las pestañas se deslizan,
cada usuario es una tarjeta y las tablas se desplazan dentro de su panel. Para verlo sin
impresora: `npm test` y luego `node test/vista.mjs` → `http://localhost:8123/pedk/app_notify/impresion` (PIN `2580`).

## Cuántos usuarios

Medido en el equipo el 21-09-2026 (con una prueba de capacidad que se quitó después; dos
veces, con el mismo resultado): cada usuario
ocupa ~270 bytes con nombre y contadores, y **cada trabajo contado reescribe todos
los datos**, ~0,85 s por cada 1000 usuarios (500 → 0,44 s; 1000 → 0,85 s; 3000 → 2,4 s).
Mientras dura, el panel y el guardián esperan.

**Recomendado hasta 500 usuarios; máximo 1000.** La app avisa a partir de 500
(`USUARIOS_AVISO`) y no deja pasar de 1000 (`USUARIOS_MAX`). El espacio no es el límite:
3000 usuarios cupieron sin problema. (La "memoria 1 GB" de la ficha de Pantum es RAM, no
el almacenamiento de la app.)

## Qué está medido

Los detalles del firmware (por qué `EncryptJobPrint` lanza y cómo se esquiva, que el
tipo llega como `PRINT`, la señal de las comillas, el filtro por número de trabajo, el
reloj adelantado del equipo) están en `src/retencion.js`, `src/vigia.js` y
`src/explorar.js` (Ajustes → Diagnóstico → **Explorar SDK** vuelca la fuente del firmware
al log).

| | Estado |
|---|---|
| Flujo de retención completo: crear usuario, listar, imprimir con PIN, contar por persona | **Comprobado en el equipo** (16-09-2026) |
| Guardián: la impresión normal se cancela sin sacar papel | **Comprobado** (16-09-2026) |
| `EncryptJobPrint` desde la app: se esquiva la trampa `setJobId` y se usa la base nativa | **Comprobado** (variante "propia") |
| Historial: `enableJobHistory` lo reactiva; se cuenta por `job_id` > base del arranque | **Comprobado** (el reloj del equipo va adelantado, no fiar del tiempo) |
| Pantallas en el panel real (coordenadas, teclado de texto, crear usuario) | **Comprobado** |
| Datos tras un apagón | **Comprobado**. Tras **reinstalar** se pierden: usar la copia de seguridad |
| Panel web: rutas, formularios, topes de entrada y salida | **Comprobado** (21-09-2026, con curl contra el equipo) |
| Copia de seguridad web, importación desde Excel | **Comprobado** en el equipo |
| Fotocopia con PIN en retención + "Ir a copiar" + vuelta con `on_front` | **Comprobado** (22-09-2026, con log) |
| Capacidad | **Medida** (ver "Cuántos usuarios") |

## Primera instalación (en este orden)

1. **Dejar `auto boot` desactivado** en el PEDK Installer e instalar `build/impresion_signed.tar`.
2. Abrir el panel web (ver arriba) y entrar con `2580` → **Ajustes → PIN de administrador**: cambiarlo y apuntarlo.
3. **Usuarios**: dar de alta a cada persona (a mano o con **Importar Excel**).
4. En cada PC, driver Pantum → **Preferencias de impresión → Tipo de trabajo →
   Impresión segura**, con **Nombre = usuario** y **Contraseña = PIN** de esa persona.
5. **Ajustes → Pasar a retención**, **Copia: Pedir PIN** (si se quiere) y **Bloqueo: Encender**.
   El inicio del panel debe decir "Sólo se imprime con usuario y PIN".
6. Probar de punta a punta: una **impresión normal** (no debe salir), una **segura**
   (entrar, imprimirla, ver el contador) y, si aplica, una **fotocopia** con "Ir a copiar".
7. **Copia de seguridad → Descargar copia**, y guardarla.

`Ajustes → Diagnóstico` (en el panel) sigue estando para inspeccionar el equipo:
interruptores, historial, prueba de cerradura, **Trabajos** (qué llega y cancelar uno a
mano), **Explorar SDK** y el estado de la web.

## Actualizar la app sin perder datos

**Reinstalar borra usuarios, contadores, ajustes y el PIN de administrador** (medido el
21-09-2026). Siempre:

1. Web → Ajustes → Copia de seguridad → **Descargar copia**.
2. Instalar el `.tar` nuevo.
3. Web (PIN `2580`, el de fábrica, porque se borró) → Copia de seguridad → **Subir copia**.
   Vuelven usuarios con su PIN y su nombre, contadores, ajustes, PIN de
   administrador, modo y bloqueo.

Subir una copia **no borra a nadie**, y si la impresora ya tiene contadores en marcha no
los pisa. Acepta también los `.json` del antiguo respaldo al PC (`herramientas/respaldos/`),
incluso los de antes del cambio de nombre de la app (`impresion-pin-BM5220ADW`). Al pasar
de aquella versión hay que **desinstalar primero la vieja**: con otro nombre, el equipo
las trataría como dos apps y correrían dos guardianes.

## Importar usuarios desde Excel

Usuarios → **Importar Excel**:

1. **Descargar plantilla**: `.xlsx` con Usuario, PIN y Nombre completo, en **formato
   texto** (si no, Excel se come el cero inicial de los PIN) y una hoja de instrucciones.
   Sin filas de ejemplo, a propósito.
2. Elegir el `.xlsx` (o un `.csv`) → **Revisar**: vista previa fila a fila (nuevo / ya
   existe: se salta / el error). Los PIN no se muestran.
3. **Importar**: se dan de alta sólo los válidos. La impresora vuelve a validar cada fila
   con las reglas del alta manual y guarda **una sola vez**.

El Excel se lee **en el navegador** (un `.xlsx` es un ZIP con XML: `DecompressionStream` y
`DOMParser`, sin librerías ni internet). Quien ya existe **no se cambia**. El fichero
lleva los PIN en claro: borrarlo o guardarlo como confidencial.

La plantilla se regenera con `python herramientas/hacer-plantilla.py`, que escribe
`herramientas/plantilla-usuarios.xlsx` y la incrusta en `src/plantilla.js`.

## Avisos importantes

- **Sólo se imprime con usuario y contraseña.** Cada PC debe enviar con "Impresión
  segura"; lo que llegue como impresión normal se cancela sin salir papel.
- **Una sola app por equipo**: instalarla desplaza a la que haya.
- **Reinstalar borra los datos**: ver "Actualizar la app sin perder datos".
- **Antes de desinstalar: Ajustes → Desbloquear equipo.** En modo retención el bloqueo no
  toca la impresión de red, pero si se usó la copia con PIN o el modo sesión, desinstalar
  así puede dejar funciones apagadas; reinstalar la app lo arregla.
- El bloqueo viene **apagado de fábrica** y no se deja encender sin usuarios.
- Los PIN se guardan como huella, no en claro; tras 5 intentos fallidos ese usuario queda
  bloqueado 5 minutos. **La copia de seguridad lleva esas huellas**: un
  PIN de 4 dígitos se rompe probando las 10.000 combinaciones, así que valen lo mismo que
  la lista de PIN. Guardarla como confidencial.
- El log del equipo (`Pedk1.log`) deja de grabar a los ~2 MiB (~41 min de uso): para
  diagnosticar, reiniciar y reproducir lo primero.

## Respaldos

Los hace el administrador desde la web: **Ajustes → Copia de seguridad → Descargar
copia**, y se guarda el fichero donde convenga. No hay respaldo automático: el antiguo
respaldo por red a un PC (con un servidor en Python) se quitó el 22-09-2026 para no
depender de un PC encendido. La app **no puede escribir en una flash USB** (medido el
17-09-2026: del USB sólo se exponen interruptores), así que la copia sale por la web.

## Compilar, probar e instalar

```bash
npm install         # la primera vez (incluye @xmldom/xmldom, sólo para las pruebas)
npm test            # recorrido completo contra un pedk simulado; SIEMPRE antes de firmar
npm run build       # vite build + pedk-build
npm run sign:dev    # -> build/impresion_signed.tar
```

Instalar `build/impresion_signed.tar` con **PEDK Installer** (antes, descargar la copia).

- Las pruebas cubren también el panel web emulando el navegador: la lista, el CSV, la
  copia (comprimida y sin comprimir, hasta 1000 usuarios) y la importación con ficheros
  **guardados por Excel de verdad** (`test/fixtures/`).
- Firma con el certificado de desarrollo `6e6667db…` (vence el **23-01-2027**). La llave
  (`sign/*.key`) está en `.gitignore`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `src/app.js` | Pantallas del panel: inicio, usuario, PIN, sesión, documentos retenidos, Copiar y Escanear; arranque |
| `src/copia.js` | Pantalla de copia desde la app (`pedk.jobs.copy`): copias, estados y cancelar |
| `src/escaneo.js` | Pantalla de escaneo (`pedk.jobs.scan`): destino por persona, formato, color, otra página y terminar |
| `src/estados.js` | Escucha los avisos del equipo (`pedk.device.status`) y los traduce a lo que ve la persona |
| `src/ajustes.js` | Ajustes en el panel: usuarios, contadores, últimos trabajos, modo, bloqueo, PIN admin |
| `src/acciones.js` | Modo, bloqueo, copia, duración y desbloqueo: lógica común al panel y a la web |
| `src/web.js` | Panel web: login, usuarios, importar, contadores, ajustes, copia de seguridad; troceo de respuestas y subidas |
| `src/inflate.js` | Descompresor deflate para las subidas comprimidas del navegador |
| `src/plantilla.js` | Plantilla de Excel incrustada (generada por `herramientas/hacer-plantilla.py`) |
| `src/router.js` | Pantalla activa y repintado; no dibuja mientras se está fuera de la app |
| `src/diagnostico.js` | Qué implementa el firmware + prueba de cerradura con un trabajo real |
| `src/vigia.js` | Escucha los trabajos que llegan y el guardián: cancela toda impresión normal |
| `src/explorar.js` | Vuelca la fuente del firmware y prueba la memoria (sólo diagnóstico) |
| `src/cerradura.js` | Interruptores del equipo, con relectura |
| `src/sesion.js` | Sesión abierta y a quién se carga cada trabajo |
| `src/historial.js` | Lee el historial y entrega los trabajos nuevos una sola vez |
| `src/retencion.js` | Impresión confidencial (modo retención) |
| `src/store.js` | Memoria del equipo: usuarios, huellas de PIN, contadores, registro, copia, importación, máximo |
| `src/ui.js` | Widgets, teclado numérico y teclado de texto |
| `herramientas/hacer-manuales.mjs` | Convierte los manuales de `doc/` en PDF A4 con Chrome |
| `herramientas/hacer-plantilla.py` | Genera la plantilla de Excel y la incrusta en la app |
| `herramientas/plantilla-usuarios.xlsx` | La plantilla, para tenerla a mano |
| `herramientas/Impresión con PIN.url` | Acceso directo al panel web |
| `test/` | Simulador de `pedk`, pruebas, ficheros de Excel de prueba y `vista.mjs` (vista previa del panel web sin impresora) |
| `doc/` | Manuales: usuario, administrador e instalación con prueba de aceptación |
