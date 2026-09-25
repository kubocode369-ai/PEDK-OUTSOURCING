# Vizo — instalación y entrega

Para quien instala la app en casa del cliente. Sigue el orden: cada paso da por hecho el
anterior.

---

## Antes de ir

| Comprobar | Por qué |
|---|---|
| El `.tar` firmado (`build/impresion_signed.tar`) | Es lo que se instala |
| El PEDK Installer | Es lo único que instala apps en el equipo |
| La impresora ejecuta apps PEDK | ⚠️ Pendiente de confirmar con Pantum si el firmware de fábrica vale |
| Lista de usuarios y PIN, o el Excel relleno | Para no dar de alta a mano delante del cliente |
| Datos de la carpeta de escaneos y del SMTP | Ver el manual del administrador |

---

## En sitio, por orden

### 1. Red

- [ ] Anota la **IP de la impresora** (panel → Información de red).
- [ ] Pide al responsable de redes una **reserva de IP** para la impresora. Si cambia, la
      web de administración deja de funcionar.
- [ ] Si va a haber escaneo a carpeta, **reserva también la IP del PC** que la aloja.

### 2. Instalar

- [ ] Si ya hubiera una versión instalada: **Web → Ajustes → Respaldo → Descargar**.
- [ ] Instala `impresion_signed.tar` con el PEDK Installer.
- [ ] La app arranca sola. Comprueba en el panel que se dibuja la pantalla de inicio.
- [ ] Si había respaldo: **Web → Ajustes → Respaldo → Subir**.

### 3. Seguridad mínima

- [ ] **Cambia el PIN de administrador** (de fábrica es 2580).
- [ ] Apunta el nuevo PIN donde el cliente lo tenga, no sólo tú.

### 4. Usuarios

- [ ] Importa el Excel, o da de alta a las personas una a una.
- [ ] Pon el **correo** a quien vaya a escanear a su correo.

### 5. Destinos de escaneo (los que apliquen)

- [ ] **Carpeta**: prepara el PC (usuario `escaner`, recurso compartido, firewall) y
      rellena Ajustes → Carpeta.
- [ ] **Correo**: configura el SMTP en la web de Pantum y **manda el correo de prueba**.
- [ ] **USB**: comprueba que el puerto del disco U está **encendido** en el equipo.

### 6. Los PC

- [ ] En **cada PC**, configura el driver con impresión segura: Nombre = usuario,
      Contraseña = PIN.
- [ ] Haz una impresión de prueba desde al menos un PC.

### 7. Encender el bloqueo

- [ ] Sólo cuando lo anterior esté hecho: **Ajustes → Bloqueo: ENCENDIDO**.
- [ ] **Copia: con PIN** y **Escaneo: con PIN**.

### 8. Respaldo final

- [ ] **Web → Ajustes → Respaldo → Descargar** y guarda el fichero en un sitio del
      cliente, no sólo en tu portátil.

---

## Prueba de aceptación

Hazla **delante del cliente** y que firme. Cada fila es una comprobación real.

| # | Prueba | Resultado esperado | ✔ |
|---|---|---|---|
| 1 | Imprimir desde un PC **sin** identificarse | No sale papel; el documento espera | |
| 2 | Entrar con usuario y PIN, liberar ese documento | Sale el papel | |
| 3 | Entrar con un **PIN equivocado** | No deja entrar | |
| 4 | Sin sesión, intentar **fotocopiar** en el panel | Se niega | |
| 5 | Con sesión, **Copiar** → 2 copias | Salen 2 hojas | |
| 6 | Sin sesión, intentar **escanear** (panel y desde un PC) | Se niega | |
| 7 | Con sesión, **Escanear** a cada destino configurado | Llega a la memoria, la carpeta o el correo | |
| 8 | Escanear en **Color** | El PDF sale en color | |
| 9 | **Contadores**: revisar lo hecho en las pruebas | Todo contado a la persona correcta, una vez cada cosa | |
| 10 | **Descargar CSV** y abrirlo en Excel | Se abre con las columnas bien | |
| 11 | **Terminar** sesión y esperar | El equipo vuelve a quedar bloqueado | |
| 12 | Descargar el **respaldo** | El fichero se descarga | |

Firma del cliente: ________________________  Fecha: ____________

---

## Actualizar la app más adelante

```
1. Web → Ajustes → Respaldo → Descargar      (SIEMPRE, sin excepción)
2. Instalar el .tar nuevo con el PEDK Installer
3. Web → Ajustes → Respaldo → Subir
4. Comprobar: usuarios, contadores, correo de alguien y la carpeta
```

Si te saltas el paso 1, se pierden usuarios, contadores y ajustes. No hay forma de
recuperarlos desde el equipo.

---

## Desinstalar

1. **Web o panel → Ajustes → Desbloquear equipo.** Imprescindible: los interruptores del
   equipo (impresión, copia, escaneo) **no se restauran solos** al quitar la app, y la
   impresora se quedaría bloqueada para todos.
2. Descarga el respaldo, por si acaso.
3. Quita la app con el PEDK Installer.
