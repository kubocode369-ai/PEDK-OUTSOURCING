# Vizo — manual del administrador

Todo se administra desde una página web que **sirve la propia impresora**. No hace falta
servidor, ni instalar nada en ningún PC, ni internet.

```
http://<IP de la impresora>/pedk/app_notify/vizo/
```

Entra con el **PIN de administrador**. De fábrica es **2580** y es lo primero que hay que
cambiar.

> ⚠️ **La barra del final es obligatoria.** Sin ella la impresora contesta "app name
> is not find!!!" aunque la aplicación esté funcionando.

> **Reserva la IP de la impresora en el router.** Si cambia, la dirección deja de
> funcionar y hay que buscarla otra vez en el panel del equipo.

---

## 1. Usuarios

**Web → Usuarios**

| Acción | Cómo |
|---|---|
| Dar de alta | **Nuevo** → usuario, PIN, nombre completo y correo (los dos últimos, opcionales) |
| Cambiar el PIN | Entra en la persona → **PIN nuevo** → Cambiar PIN |
| Desactivar | Entra en la persona → **Desactivar**. Sigue en la lista con sus contadores, pero no puede entrar |
| Borrar | Entra en la persona → **Borrar**. Sus contadores se conservan marcados como "usuario borrado" |

**Reglas del usuario**: minúsculas, números, punto, guion y guion bajo. Sin espacios ni
acentos. Es el nombre que se pone en el driver de cada PC, así que conviene que sea corto
(`jperez`, `contabilidad2`).

**Reglas del PIN**: sólo dígitos. Tras varios intentos fallidos el equipo se frena unos
minutos a propósito.

**El correo** sólo sirve para que esa persona pueda escanear a su propio correo. Si lo
dejas vacío, simplemente no le aparece esa opción.

### Importar desde Excel

Para dar de alta a mucha gente de una vez:

1. **Web → Usuarios → Importar** y descarga la plantilla (también está en
   `herramientas/plantilla-usuarios.xlsx`).
2. Rellena las tres columnas: **usuario · PIN · nombre completo**.
3. Súbela.

Te dirá cuántos creó, cuántos ya existían (a ésos **no los toca**) y qué filas estaban
mal, con el número de fila. Para cambiarle algo a alguien que ya existe, entra en su
ficha; la importación nunca pisa datos.

**Capacidad**: hasta **500 personas** recomendado, **1000** como máximo. El límite no es
el espacio sino el tiempo de guardado: con 1000 usuarios, cada vez que se guarda tarda
casi un segundo y durante ese rato el panel no responde.

---

## 2. Ajustes

**Web → Ajustes** (o en el panel del equipo, Ajustes)

| Ajuste | Qué hace | Recomendado |
|---|---|---|
| **Modo** | *Retención*: los documentos esperan en cola y cada quien libera los suyos. *Sesión*: desbloquea el equipo entero al entrar | **Retención** |
| **Bloqueo** | El interruptor general. Apagado, la impresora funciona como una impresora normal | **ENCENDIDO** (tras dar de alta a la gente) |
| **Copia** | *Con PIN*: sin sesión no se puede fotocopiar | **Con PIN** |
| **Escaneo** | *Con PIN*: sin sesión no se puede escanear, ni desde el panel ni desde un PC | **Con PIN** |
| **Sesión** | Minutos de inactividad antes de cerrar sola | 3 min |
| **Cambiar PIN admin** | Vale para la web y para el panel | Cámbialo el primer día |
| **Desbloquear equipo** | Salida de emergencia: enciende todo y apaga el bloqueo | Sólo si algo va mal |

> ⚠️ **Enciende el Bloqueo cuando ya tengas usuarios dados de alta.** Con el bloqueo
> puesto y sin usuarios, nadie puede usar la impresora.

> ⚠️ **Antes de desinstalar la app, pulsa "Desbloquear equipo".** Los interruptores del
> equipo no se restauran solos al quitarla, y la impresora se quedaría bloqueada.

---

## 3. Escanear a la carpeta de cada persona (SMB)

Cada persona recibe lo suyo en **una subcarpeta con su nombre de usuario**. La impresora
la **crea sola** la primera vez, así que dar de alta gente nueva no requiere tocar el PC.

### En el PC que guarda los escaneos (una sola vez)

Abre el **Símbolo del sistema como administrador** y ejecuta, **uno por uno**:

```
net user escaner UNACLAVE /add

icacls C:\Escaneos /grant "escaner:(OI)(CI)M"

net share Escaneos=C:\Escaneos /grant:escaner,CHANGE

netsh advfirewall firewall set rule group="Compartir archivos e impresoras" new enable=Yes

net share Escaneos
```

(Antes, crea la carpeta `C:\Escaneos`.)

Por qué así:

- **Un usuario local dedicado** (`escaner`), no tu cuenta: las cuentas de Microsoft no
  sirven para SMB, y no conviene dar tu contraseña a una impresora.
- **Con contraseña**: Windows bloquea el acceso en red a cuentas sin contraseña.
- **El firewall**: viene cerrado para compartir archivos; sin abrirlo la impresora no
  llega.
- La red del PC debe estar como **Privada**, no Pública.

### En la app

**Web → Ajustes → Carpeta**

| Campo | Ejemplo |
|---|---|
| Servidor o IP | `192.168.0.100` |
| Carpeta | `Escaneos` (el nombre del recurso compartido, no la ruta del disco) |
| Usuario | `escaner` |
| Contraseña | la que pusiste |
| Puerto | `445` |

> 🔒 Esa contraseña se guarda tal cual (hay que dársela al equipo en cada trabajo) y
> **viaja en la copia de seguridad**. Usa una cuenta que sólo pueda escribir en esa
> carpeta, nunca la de administrador del PC.

**El PC tiene que estar encendido** cuando alguien escanee, y con IP fija o reservada.

---

## 4. Escanear al correo (SMTP)

Esto **no se configura en nuestra app**, sino en la página web propia de Pantum:

**`http://<IP>` → Configuración → Configuración de red → Configuración de protocolo → SMTP**

| Campo | Qué poner |
|---|---|
| Servidor SMTP | El de tu dominio (`mail.tuempresa.com`) |
| Puerto | `465` con SSL/TLS, o `587` con TLS |
| Modo de codificación | SSL/TLS (con el 465) |
| Autenticación | Requiere autenticación |
| Nombre de inicio de sesión | La dirección completa (`escaner@tuempresa.com`) |
| Contraseña | La de esa cuenta |
| Correo del dispositivo | La misma dirección: es el remitente |

Luego pulsa **"Dirección de buzón de prueba"** y mándate un correo. **Hasta que esa
prueba no llegue, no busques el fallo en la app.**

Avisos:
- Con Gmail o Microsoft 365 necesitas una **contraseña de aplicación**, no la normal.
- La impresora necesita salida a internet si usas un correo externo.
- Crea una cuenta dedicada (`escaner@…`), no la de una persona.

---

## 5. Escanear a memoria USB

No hay nada que configurar en la app, pero **el puerto USB del equipo puede venir
apagado de fábrica**. Si al escanear a USB la impresora dice *"El puerto del disco U está
deshabilitado"*, enciéndelo en la configuración del propio equipo (panel o web de
Pantum, en los ajustes de USB).

---

## 6. El driver de cada PC

Para que la impresión con PIN funcione, **cada PC** debe tener el driver configurado con
impresión segura:

1. Panel de control → Dispositivos e impresoras → la Pantum → **Preferencias de impresión**.
2. Busca **Impresión segura** (o "Modo de impresión" → Segura).
3. **Nombre de usuario** = el usuario de la persona en la app.
4. **Contraseña** = su PIN.

Sin esto, el documento se cancela en la impresora y no sale nada.

---

## 7. Contadores

**Web → Contadores**: todas las personas, con impresiones, copias y escaneos, sus páginas
y el total de papel.

- **Descargar CSV** abre directamente en Excel (separador `;`).
- **Poner a cero** borra todos los contadores. **Descarga el CSV antes.**
- Quien no se identificó aparece como *"Sin identificar"*. Si esa fila crece, algo se
  está colando: revisa que el bloqueo esté encendido.
- Los escaneos van en su propia columna y **no** suman al total de papel, porque escanear
  no gasta papel.

---

## 8. Copias de seguridad — la regla de oro

**Reinstalar la app borra todos los datos**: usuarios, contadores y ajustes.

```
ANTES de instalar cualquier versión:   Web → Ajustes → Respaldo → Descargar
DESPUÉS de instalar:                   Web → Ajustes → Respaldo → Subir
```

La copia se lleva usuarios (con sus PIN), contadores, últimos trabajos, ajustes, el
correo de cada persona y la carpeta compartida con su contraseña.

Detalles que conviene saber:
- Restaurar **nunca borra** usuarios que ya existan: los actualiza o añade los que falten.
- Los contadores **sólo** se restauran si están vacíos, para no pisar los buenos con
  cifras viejas.
- Guarda el fichero fuera del PC (una carpeta de red o la nube). Contiene las huellas de
  los PIN y la contraseña de la carpeta de escaneos.
- Haz una copia al menos cada mes, y siempre después de dar de alta a mucha gente.

---

## 9. Cuando algo va mal

| Síntoma | Causa más probable |
|---|---|
| Al escanear sólo aparece "Memoria USB" | Restauraste una copia vieja: vuelve a poner el correo en las fichas y la carpeta en Ajustes |
| El escaneo a USB se cancela solo | El puerto del disco U está apagado en el equipo |
| El escaneo a correo no llega | Prueba el botón de correo de prueba en la web de Pantum; casi siempre es el SMTP |
| El escaneo a carpeta no llega | El PC está apagado, cambió de IP, o la contraseña de `escaner` caducó |
| La pantalla se queda en "Escaneando" | Falta pulsar **TERMINAR** |
| Nadie puede imprimir | El bloqueo está encendido y el driver del PC no tiene la impresión segura |
| La web no abre | La impresora cambió de IP: búscala en el panel del equipo |
| Trabajos contados a "Sin identificar" | Alguien imprimió sin sesión, o el bloqueo estaba apagado |

Para diagnosticar a fondo: **panel del equipo → Ajustes → Diagnóstico**. Ahí se ve el
estado de los interruptores, el historial, la web y el canal de avisos del equipo.
