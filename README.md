# Impresión con PIN — Pantum BM5220ADW

App PEDK que corre **dentro de la impresora**. Nadie imprime sin identificarse en el panel
con **usuario y PIN**, y se cuenta lo que imprime (y copia) cada persona. No necesita
servidor ni internet: usuarios, contadores y ajustes viven en la memoria del equipo.

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

**Modo sesión (alternativo, no recomendado)**: el equipo se desbloquea al entrar y se
bloquea al salir, con la cerradura de interruptores. No sirve para "sólo con PIN" porque
apagar la impresión de red bloquea también la impresión segura.

## Qué está medido

Los detalles del firmware (por qué `EncryptJobPrint` lanza y cómo se esquiva, que el
tipo llega como `PRINT`, la señal de las comillas, el filtro por número de trabajo, el
reloj adelantado del equipo) están en la memoria del proyecto y en `src/retencion.js`,
`src/vigia.js` y `src/explorar.js` (Ajustes → Diagnóstico → **Explorar SDK** vuelca la
fuente del firmware al log).

| | Estado |
|---|---|
| Flujo de retención completo: crear usuario, listar, imprimir con PIN, contar por persona | **Comprobado en el equipo** (16-09-2026) |
| Guardián: la impresión normal se cancela sin sacar papel | **Comprobado** (16-09-2026) |
| `EncryptJobPrint` desde la app: se esquiva la trampa `setJobId` y se usa la base nativa | **Comprobado** (variante "propia") |
| Historial: `enableJobHistory` lo reactiva; se cuenta por `job_id` > base del arranque | **Comprobado** (el reloj del equipo va adelantado, no fiar del tiempo) |
| Pantallas en el panel real (coordenadas, teclado de texto, crear usuario) | **Comprobado** |

## Primera instalación (en este orden)

1. **Dejar `auto boot` desactivado** en el PEDK Installer y abrir la app a mano.
2. **Ajustes** (PIN de fábrica `2580`) → **Cambiar PIN admin**.
3. **Ajustes → Modo: retención**.
4. **Usuarios → + Nuevo usuario** para cada persona (nombre + PIN).
5. En cada PC, driver Pantum → **Preferencias de impresión → Tipo de trabajo →
   Impresión segura**, con **Nombre = usuario** y **Contraseña = PIN** de esa persona.
6. **Ajustes → Bloqueo: ENCENDIDO**. El inicio debe decir "Sólo se imprime con usuario y PIN".
7. Probar de punta a punta: mandar una **impresión normal** (no debe salir), mandar una
   **segura**, entrar con usuario y PIN, imprimirla y ver el contador.

`Ajustes → Diagnóstico` sigue estando para inspeccionar el equipo: interruptores,
historial, prueba de cerradura, **Trabajos** (qué llega y cancelar uno a mano) y
**Explorar SDK** (vuelca la fuente del firmware al log).

## Avisos importantes

- **Sólo se imprime con usuario y contraseña.** Cada PC debe enviar con "Impresión
  segura"; lo que llegue como impresión normal se cancela sin salir papel.
- **Una sola app por equipo**: instalarla desplaza a la que haya.
- **Reinstalar o actualizar la app BORRA usuarios, contadores y el PIN de admin**
  (`setUserDefinedData` no sobrevive, medido el 15-08-2026). Anotar los contadores antes,
  y volver a poner Modo retención + Bloqueo tras reinstalar.
- **Antes de desinstalar: Ajustes → Desbloquear equipo.** En modo retención el bloqueo no
  toca los interruptores, pero si alguna vez se usó el modo sesión con el bloqueo puesto,
  desinstalar así deja la impresora sin aceptar trabajos de PC; reinstalar la app lo arregla.
- El bloqueo viene **apagado de fábrica** y no se deja encender sin usuarios.
- Los PIN se guardan como huella, no en claro; tras 5 intentos fallidos ese usuario queda
  bloqueado 5 minutos.

## Compilar, probar e instalar

```bash
npm test            # recorrido completo contra un pedk simulado; SIEMPRE antes de firmar
npm run build       # vite build + pedk-build
npm run sign:dev    # -> build/impresion-pin-BM5220ADW_signed.tar
```

Instalar `build/impresion-pin-BM5220ADW_signed.tar` con **PEDK Installer**.

- `node_modules/` se copió del agente de CloudPrint (mismo SDK `pedk-1.00.012`); `npm install`
  también sirve si hay red.
- Firma con el certificado de desarrollo `6e6667db…` (vence el **23-01-2027**). La llave
  (`sign/*.key`) está en `.gitignore`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `src/app.js` | Pantallas: inicio, usuario, PIN, sesión, documentos retenidos; arranque |
| `src/ajustes.js` | Usuarios, contadores, últimos trabajos, bloqueo, modo, duración, copia, PIN admin |
| `src/diagnostico.js` | Qué implementa el firmware + prueba de cerradura con un trabajo real |
| `src/vigia.js` | Escucha los trabajos que llegan y el guardián: cancela toda impresión normal |
| `src/explorar.js` | Vuelca la fuente del firmware sobre impresión segura (sólo diagnóstico) |
| `src/cerradura.js` | Interruptores del equipo, con relectura |
| `src/sesion.js` | Sesión abierta y a quién se carga cada trabajo |
| `src/historial.js` | Lee el historial y entrega los trabajos nuevos una sola vez |
| `src/retencion.js` | Impresión confidencial (modo retención) |
| `src/store.js` | Memoria del equipo: usuarios, huellas de PIN, contadores, registro |
| `src/ui.js` | Widgets, teclado numérico y teclado de texto |
| `test/` | Simulador de `pedk` y pruebas |
