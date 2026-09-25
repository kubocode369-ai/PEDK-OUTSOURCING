/**
 * Vizo — impresión con PIN para Pantum BM5220ADW.
 *
 * Nadie imprime sin identificarse en el panel con su usuario y su PIN, y se cuenta lo
 * que imprime (y copia) cada persona. Todo vive en la impresora; no hay servidor.
 *
 *  Modo SESIÓN (por defecto): el equipo está bloqueado. La persona entra con usuario
 *    y PIN, el equipo se desbloquea, imprime desde su PC y al pulsar "Terminar" (o al
 *    pasar unos minutos sin actividad) se vuelve a bloquear. Lo que sale mientras
 *    tanto se le carga a ella, leído del historial del equipo.
 *
 *  Modo RETENCIÓN: el PC envía como impresión confidencial; el documento espera en
 *    el equipo y se libera tras entrar. Depende de que el firmware lo soporte (ver
 *    retencion.js: en julio de 2026 no funcionó en este equipo).
 *
 * Lo que se da por medido y lo que no está en README.md. Antes de encender el bloqueo
 * en un equipo nuevo: Ajustes > Diagnóstico > Probar cerradura.
 */
import { config } from './config.js';
import { guard } from './guard.js';
import { enReposo, escucharDespertar } from './powerSave.js';
import { COLOR, ambito, boton, etiqueta, pantalla, paginador, paginar, recortar, tecladoNumerico, tecladoTexto } from './ui.js';
import { conectarDibujo, mostrar, repintar, pantallaActiva, salioDeLaApp, volvioALaApp, tiempoFuera } from './router.js';
import * as store from './store.js';
import * as cerradura from './cerradura.js';
import * as historial from './historial.js';
import * as sesion from './sesion.js';
import * as retencion from './retencion.js';
import * as diagnostico from './diagnostico.js';
import * as vigia from './vigia.js';
import * as web from './web.js';
import * as acciones from './acciones.js';
import * as copia from './copia.js';
import * as escaneo from './escaneo.js';
import * as estados from './estados.js';
import { abrirAjustes } from './ajustes.js';

const { ScreenCtrl, KeyCtrl } = pedk.ui;
const panel = new ScreenCtrl();

let ultimosWidgets = null;
let ultimoPintado = 0;

function dibujar(widgets) {
    ultimosWidgets = widgets;
    ultimoPintado = Date.now();
    panel.draw(widgets);
}

/* ------------------------------------------------------------------ */
/* Estado de las pantallas                                              */
/* ------------------------------------------------------------------ */

let mensaje = '';
let colorMensaje = COLOR.suave;
let usuarioEscrito = '';
let pinEscrito = '';
let pinParaAdmin = false;

/** Lo que salió en la sesión en curso, para enseñárselo a la persona. */
let cuentaSesion = null;
/** Documentos retenidos (modo retención). */
let retenidos = [];
let pagina = 0;

/** Lectura del interruptor principal; se refresca en los cambios, no en cada pintado. */
let bloqueado = null;
let avisoCerradura = null;

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

function refrescarCerradura() {
    bloqueado = cerradura.impresionBloqueada();
}

/* ------------------------------------------------------------------ */
/* Inicio                                                               */
/* ------------------------------------------------------------------ */

function irInicio() {
    usuarioEscrito = '';
    pinEscrito = '';
    pinParaAdmin = false;
    pagina = 0;
    refrescarCerradura();
    mostrar('inicio', renderInicio);
}

function estadoInicio() {
    const a = store.ajustes();
    if (!a.bloqueoActivo) {
        return ['Bloqueo apagado: el equipo imprime sin PIN', COLOR.aviso];
    }
    if (a.modo === 'retencion') {
        return ['Sólo se imprime con usuario y PIN', COLOR.ok];
    }
    if (bloqueado === true) {
        return ['Equipo bloqueado: entre para imprimir', COLOR.ok];
    }
    return ['ATENCIÓN: el equipo NO quedó bloqueado', COLOR.peligro];
}

function renderInicio() {
    ambito('ini');
    const a = store.ajustes();
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 12, 456, 26, 'Vizo · Impresión con PIN', COLOR.texto, 'center'));
    const [estado, color] = estadoInicio();
    w.push(etiqueta('estado', 12, 44, 456, 22, estado, color, 'center'));
    // La memoria en sólo lectura manda sobre cualquier otro aviso: mientras dure, lo
    // que se dé de alta o se cuente no sobrevive a un apagón.
    const mem = store.estado();
    const alerta = mem.soloLectura ? 'MEMORIA NO DISPONIBLE: no se guardarán usuarios ni contadores' : avisoCerradura;
    if (alerta) {
        w.push(etiqueta('aviso', 12, 66, 456, 20, recortar(alerta, 62), COLOR.peligro, 'center'));
    }
    const pasos = a.modo === 'sesion'
        ? ['1. Entre con su usuario y PIN', '2. Imprima desde su PC', '3. Pulse Terminar al acabar']
        : ['1. En su PC: "Impresión segura", con su usuario y PIN', '2. Aquí: Entrar con el mismo usuario y PIN', '3. Elija qué imprimir'];
    pasos.forEach((p, i) => w.push(etiqueta('paso' + i, 60, 92 + i * 22, 400, 20, p, COLOR.suave)));
    w.push(boton('entrar', 90, 164, 300, 56, 'Entrar', COLOR.ok, irUsuario));
    w.push(etiqueta('msg', 12, 232, 456, 22, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(boton('ajustes', 12, 272, 140, 38, 'Ajustes', COLOR.acento, () => {
        pinParaAdmin = true;
        pinEscrito = '';
        decir('', COLOR.suave);
        mostrar('pin', renderPin);
    }));
    w.push(boton('menu', 316, 272, 152, 38, 'Menú del equipo', COLOR.suave, salirAlMenu));
    return w;
}

/**
 * Soltar el panel y volver al menú de la impresora. Comprobado en la BM5220ADW
 * (15-08-2026): `on_back()` solo no hace nada; primero hay que soltar el dibujo.
 * La app sigue viva al fondo, con su sesión y sus temporizadores.
 */
function salirAlMenu() {
    // Desde aquí no se dibuja hasta que vuelva (ver router.js): si no, la app se trae
    // al frente sola y no deja copiar.
    salioDeLaApp();
    console.log('[app] sale al menú de la impresora (' + (sesion.activa() ? 'con sesión de ' + sesion.usuario() : 'sin sesión') + ')');
    const soltar = globalThis.js_screenctrl_draw_exit;
    if (typeof soltar === 'function') {
        try { soltar(); } catch (e) { console.log('[app] draw_exit: ' + (e && e.message)); }
    }
    const proc = globalThis.process;
    if (proc && typeof proc.on_back === 'function') {
        proc.on_back();
        return;
    }
    volvioALaApp();
    decir('Este equipo no permite salir de la app', COLOR.peligro);
    repintar();
}

/* ------------------------------------------------------------------ */
/* Usuario y PIN                                                        */
/* ------------------------------------------------------------------ */

function irUsuario() {
    if (diagnostico.pruebaActiva()) {
        decir('Prueba de cerradura en curso: espere', COLOR.aviso);
        repintar();
        return;
    }
    usuarioEscrito = '';
    pinParaAdmin = false;
    decir('', COLOR.suave);
    mostrar('usuario', renderUsuario);
}

function renderUsuario() {
    ambito('usr');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 6, 200, 22, 'Su usuario', COLOR.texto));
    w.push(boton('cancelar', 238, 4, 110, 32, 'Cancelar', COLOR.suave, () => { decir('', COLOR.suave); irInicio(); }));
    w.push(boton('seguir', 356, 4, 112, 32, 'Siguiente', COLOR.ok, () => {
        if (!store.usuarioValido(usuarioEscrito)) {
            decir('Escriba su usuario', COLOR.peligro);
            repintar();
            return;
        }
        pinEscrito = '';
        decir('', COLOR.suave);
        mostrar('pin', renderPin);
    }));
    w.push(etiqueta('v', 12, 44, 456, 30, usuarioEscrito || '_', COLOR.acento, 'center'));
    w.push(etiqueta('msg', 12, 80, 456, 20, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(...tecladoTexto('kb', 156, (t) => {
        if (t === '<') {
            usuarioEscrito = usuarioEscrito.slice(0, -1);
        } else if (usuarioEscrito.length < config.USUARIO_MAX) {
            usuarioEscrito += t;
        }
        decir('', COLOR.suave);
        repintar();
    }));
    return w;
}

function renderPin() {
    ambito('pin');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 456, 22, pinParaAdmin ? 'PIN de administrador' : 'PIN de ' + recortar(usuarioEscrito, 24),
        COLOR.texto, 'center'));
    w.push(etiqueta('v', 140, 40, 200, 30, '*'.repeat(pinEscrito.length), COLOR.acento, 'center'));
    w.push(...tecladoNumerico('np', 90, 80, teclaPin));
    w.push(etiqueta('msg', 12, 254, 456, 22, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(boton('volver', 12, 282, 110, 32, 'Volver', COLOR.suave, () => {
        decir('', COLOR.suave);
        if (pinParaAdmin) {
            irInicio();
        } else {
            mostrar('usuario', renderUsuario);
        }
    }));
    return w;
}

function teclaPin(t) {
    if (t === 'C') {
        pinEscrito = '';
        decir('', COLOR.suave);
    } else if (t !== 'OK') {
        if (pinEscrito.length < config.PIN_MAX) {
            pinEscrito += t;
        }
    } else {
        entrarConPin();
        return;
    }
    repintar();
}

function entrarConPin() {
    const pin = pinEscrito;
    pinEscrito = '';
    if (pinParaAdmin) {
        if (!store.esPinAdmin(pin)) {
            decir('PIN de administrador incorrecto', COLOR.peligro);
            repintar();
            return;
        }
        decir('', COLOR.suave);
        abrirAjustes(irInicio);
        return;
    }
    // Siempre se valida a la persona con su usuario y PIN de la app: el historial va a su nombre.
    const v = store.validarUsuario(usuarioEscrito, pin);
    if (!v.ok) {
        decir(v.error, COLOR.peligro);
        repintar();
        return;
    }
    const modo = store.ajustes().modo;
    if (modo === 'retencion' && !retencion.disponible().ok) {
        decir('Este equipo no retiene trabajos: avise al administrador', COLOR.peligro);
        repintar();
        return;
    }
    const r = sesion.abrir(v.usuario, pin);
    if (!r.ok) {
        decir(r.error, COLOR.peligro);
        refrescarCerradura();
        repintar();
        return;
    }
    cuentaSesion = { impresiones: 0, paginas: 0, copias: 0, paginasCopia: 0, escaneos: 0, paginasEscaneo: 0 };
    pagina = 0;
    if (modo === 'retencion') {
        cargarRetenidos();
        decir(retenidos.length ? '' : 'Envíe con "Impresión segura", Nombre: ' + v.usuario, COLOR.suave);
        mostrar('retenidos', renderRetenidos);
        return;
    }
    decir(r.aviso || '', r.aviso ? COLOR.aviso : COLOR.suave);
    mostrar('sesion', renderSesion);
}

/* ------------------------------------------------------------------ */
/* Sesión abierta                                                       */
/* ------------------------------------------------------------------ */

function textoRestante() {
    const s = Math.ceil(sesion.restanteMs() / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function textoCuenta() {
    const c = cuentaSesion || { impresiones: 0, paginas: 0, copias: 0, paginasCopia: 0, escaneos: 0, paginasEscaneo: 0 };
    let t = c.impresiones + ' impresión(es), ' + c.paginas + ' pág.';
    if (c.copias > 0) {
        t += ' · ' + c.copias + ' copia(s), ' + c.paginasCopia + ' pág.';
    }
    if (c.escaneos > 0) {
        t += ' · ' + c.escaneos + ' escaneo(s), ' + c.paginasEscaneo + ' pág.';
    }
    return t;
}

function renderSesion() {
    ambito('ses');
    const a = store.ajustes();
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 340, 24, 'Hola, ' + recortar(sesion.usuario(), 20), COLOR.texto));
    w.push(boton('terminar', 356, 4, 112, 36, 'Terminar', COLOR.peligro, () => terminar('boton')));
    w.push(etiqueta('l1', 12, 52, 456, 22,
        a.bloqueoActivo ? 'El equipo está desbloqueado para usted.' : 'Puede imprimir.', COLOR.ok));
    w.push(etiqueta('l2', 12, 76, 456, 22, 'Imprima ahora desde su PC.', COLOR.texto));
    w.push(etiqueta('l3', 12, 116, 456, 20, 'En esta sesión:', COLOR.suave));
    w.push(etiqueta('cuenta', 12, 138, 456, 24, recortar(textoCuenta(), 60), COLOR.texto));
    w.push(etiqueta('tiempo', 12, 176, 456, 20, 'Se cierra sola en ' + textoRestante() + ' sin actividad', COLOR.tenue));
    w.push(boton('mas', 12, 206, 140, 36, 'Más tiempo', COLOR.acento, () => {
        sesion.actividad();
        repintar();
    }));
    // Copiar sin salir de la app, si este firmware deja. Si no, queda el camino de
    // siempre: irse al menú del equipo.
    if (copia.disponible()) {
        w.push(boton('copiar', 160, 206, 94, 36, 'Copiar', COLOR.acento, () => {
            sesion.actividad();
            copia.abrirCopia(() => mostrar('sesion', renderSesion));
        }));
        if (escaneo.disponible()) {
            w.push(boton('escanear', 262, 206, 104, 36, 'Escanear', COLOR.acento, () => {
                sesion.actividad();
                escaneo.abrirEscaneo(sesion.usuario(), () => mostrar('sesion', renderSesion));
            }));
            w.push(boton('menuEquipo', 374, 206, 94, 36, 'Menú', COLOR.acento, () => {
                sesion.actividad();
                salirAlMenu();
            }));
        } else {
            w.push(boton('menuEquipo', 262, 206, 206, 36, 'Menú del equipo', COLOR.acento, () => {
                sesion.actividad();
                salirAlMenu();
            }));
        }
    } else {
        w.push(boton('menuEquipo', 160, 206, 308, 36, a.bloquearCopia ? 'Ir a copiar' : 'Menú del equipo',
            COLOR.acento, () => {
                sesion.actividad();
                salirAlMenu();
            }));
    }
    w.push(etiqueta('msg', 12, 256, 456, 40, recortar(mensaje, 62), colorMensaje));
    return w;
}

function cargarRetenidos() {
    retenidos = retencion.trabajosDe(sesion.usuario(), sesion.pin());
}

function renderRetenidos() {
    ambito('ret');
    const info = paginar(retenidos, pagina, config.FILAS_POR_PAGINA);
    pagina = info.pagina;
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 340, 24, recortar(sesion.usuario(), 18) + ' · ' + info.total + ' documento(s)', COLOR.texto));
    w.push(boton('terminar', 356, 4, 112, 36, 'Terminar', COLOR.peligro, () => terminar('boton')));
    if (info.total === 0) {
        w.push(etiqueta('vacio', 12, 70, 456, 22, liberando ? 'Actualizando la lista…' : 'No tiene documentos en espera',
            COLOR.suave, 'center'));
    }
    let y = 44;
    for (const j of info.items) {
        // El equipo no da el título del documento: sólo el Nombre del driver numerado (ric, ric_1…).
        w.push(etiqueta('d' + j.id, 12, y + 2, 280, 20, 'Documento ' + (j.id + 1), COLOR.texto));
        w.push(etiqueta('g' + j.id, 12, y + 22, 280, 16, recortar(j.doc + (j.dueno ? ' · desde ' + j.dueno : ''), 38),
            COLOR.tenue));
        w.push(boton('r' + j.id, 300, y + 4, 168, 34, 'Imprimir', COLOR.ok, () => liberar(j)));
        y += 44;
    }
    w.push(...paginador('pg', 12, 222, info, () => { pagina--; repintar(); }, () => { pagina++; repintar(); }));
    w.push(boton('actualizar', 12, 256, 110, 30, 'Actualizar', COLOR.acento, () => {
        sesion.actividad();
        cargarRetenidos();
        repintar();
    }));
    if (copia.disponible()) {
        w.push(boton('copiar', 128, 256, 92, 30, 'Copiar', COLOR.acento, () => {
            sesion.actividad();
            copia.abrirCopia(() => mostrar('retenidos', renderRetenidos));
        }));
    }
    if (escaneo.disponible()) {
        w.push(boton('escanear', 226, 256, 100, 30, 'Escanear', COLOR.acento, () => {
            sesion.actividad();
            escaneo.abrirEscaneo(sesion.usuario(), () => mostrar('retenidos', renderRetenidos));
        }));
    }
    // Como en el modo sesión: con "Copia: con PIN" la copia sólo se abre al entrar, y sin
    // este botón no había forma de llegar a ella desde aquí. La sesión sigue abierta
    // mientras copia (cada copia contada la alarga) y al terminar la copia se cierra.
    const xMenu = escaneo.disponible() ? 332 : copia.disponible() ? 226 : 158;
    w.push(boton('menuEquipo', xMenu, 256, Math.min(150, 468 - xMenu), 30,
        !copia.disponible() && store.ajustes().bloquearCopia ? 'Ir a copiar' : 'Menú del equipo',
        COLOR.acento, () => {
            sesion.actividad();
            salirAlMenu();
        }));
    w.push(etiqueta('cuenta', 320, 292, 148, 20, recortar(textoCuenta(), 20), COLOR.suave));
    w.push(etiqueta('msg', 12, 292, 300, 22, recortar(mensaje || 'Se cierra sola en ' + textoRestante(), 40),
        mensaje ? colorMensaje : COLOR.tenue));
    return w;
}

let liberando = false;

/**
 * Imprime un documento retenido. El equipo identifica cada documento por su posición
 * en la lista y lo quita al imprimirlo: tras liberar uno, la lista se vuelve a pedir
 * (con un respiro para que el equipo la actualice) antes de dejar liberar otro.
 */
function liberar(j) {
    if (liberando) {
        return;
    }
    sesion.actividad();
    const r = retencion.liberar(j.id);
    if (!r.ok) {
        decir('No se pudo imprimir: ' + r.detalle, COLOR.peligro);
        cargarRetenidos();
        repintar();
        return;
    }
    // Se cuenta cuando aparezca en el historial, con las páginas que salieron de verdad.
    liberando = true;
    retenidos = [];
    decir('Imprimiendo. Retire su documento.', COLOR.ok);
    repintar();
    setTimeout(guard('trasLiberar', () => {
        liberando = false;
        if (!sesion.activa()) {
            return;
        }
        // La función nativa no dice si imprimió: si el documento sigue retenido, no salió.
        if (retencion.sigueRetenido()) {
            decir('No se confirmó la impresión: revise la bandeja', COLOR.aviso);
        }
        cargarRetenidos();
        if (pantallaActiva() === 'retenidos') {
            repintar();
        }
    }), config.RETENCION_RELEER_MS);
}

/**
 * Cierra la sesión. Antes se lee el historial una vez, para cargar a la persona lo
 * que ya terminó; lo que termine después cae en la gracia (sesion.js).
 */
function terminar(motivo) {
    if (!sesion.activa()) {
        return;
    }
    try { historial.revisar(alTrabajo); } catch (e) { /* la vigilancia lo reintenta */ }
    const quien = sesion.usuario();
    const r = sesion.cerrar(motivo);
    retenidos = [];
    avisoCerradura = r.ok ? null : 'No se pudo volver a bloquear: ' + r.resumen;
    decir(motivo === 'tiempo' ? 'Sesión de ' + quien + ' cerrada por inactividad' : 'Hasta luego, ' + quien,
        COLOR.suave);
    irInicio();
}

/* ------------------------------------------------------------------ */
/* Contabilidad                                                         */
/* ------------------------------------------------------------------ */

/**
 * El guardián: en modo retención con el bloqueo puesto, sólo se imprime con usuario y
 * contraseña. Cada impresión que llega del PC se cancela salvo que sea segura
 * (guardándose: su nombre viene entre comillas — medido 16-09-2026) o la acabe de
 * liberar la app (ventana abierta). Copia y escaneo del panel no se tocan.
 */
function esNombreCitado(doc) {
    const s = String(doc || '');
    return s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"';
}

function decidirGuardian(e) {
    const a = store.ajustes();
    if (a.modo !== 'retencion' || !a.bloqueoActivo) {
        return 'ignorar';
    }
    if (String(e.tipo).indexOf('PRINT') < 0) {
        return 'ignorar';   // copia, escaneo, fax: no es impresión desde PC
    }
    if (esNombreCitado(e.doc)) {
        return 'permitir';  // trabajo seguro guardándose: no se toca
    }
    if (retencion.ventanaAbierta()) {
        return 'permitir';  // lo acaba de liberar la app
    }
    return 'cancelar';
}

/**
 * Número de trabajo más alto que YA había al arrancar. Sólo se cuenta lo que llega con
 * un número mayor: los `job_id` del equipo suben con cada trabajo, y cuando al activar
 * el registro afloran trabajos viejos, vienen con números MÁS BAJOS. Es a prueba de
 * relojes desajustados (el de la impresora va adelantado respecto al del motor).
 */
let baseJobId = null;

function numeroDe(id) {
    return /^\d+$/.test(String(id)) ? parseInt(id, 10) : null;
}

function fijarBaseHistorial() {
    let max = null;
    for (const e of historial.leerEntradas()) {
        const n = numeroDe(e.id);
        if (n !== null && (max === null || n > max)) {
            max = n;
        }
    }
    baseJobId = max;
    console.log('[arranque] base del historial: último trabajo #' + (max === null ? '?' : max));
}

/** Cada trabajo nuevo del historial (impresión o copia). */
function alTrabajo(e) {
    // Sólo cuenta lo posterior a lo que ya había: los números viejos que afloran al
    // activar el registro (más bajos que la base) son historia previa, no de nadie.
    const n = numeroDe(e.id);
    if (baseJobId !== null && n !== null && n <= baseJobId) {
        return;
    }
    // Un trabajo de impresión con 0 páginas es un seguro guardándose, no una hoja que salió.
    if (e.tipo === 'PRINT' && e.paginas === 0) {
        return;
    }
    const quien = sesion.quienUsa();
    store.contar(quien, e);
    console.log('[cuenta] #' + e.id + (e.hora ? '@' + e.hora : '') + ' ' + e.tipo + ' ' + e.paginas + ' pág. -> ' + quien
        + (e.estado ? ' (' + e.estado + ')' : '') + ' · equipo: ' + (e.origen || 'sin usuario'));
    if (quien === store.SIN_SESION) {
        if (diagnostico.pruebaActiva()) {
            diagnostico.anotarFuga(e);
        } else if (store.ajustes().bloqueoActivo) {
            console.log('[cuenta] AVISO: trabajo sin sesión con el bloqueo encendido');
        }
        return;
    }
    if (sesion.activa() && quien === sesion.usuario() && cuentaSesion) {
        sesion.actividad();
        if (e.tipo === 'COPY') {
            cuentaSesion.copias++;
            cuentaSesion.paginasCopia += e.paginas;
        } else if (e.tipo === 'SCAN') {
            cuentaSesion.escaneos++;
            cuentaSesion.paginasEscaneo += e.paginas;
        } else {
            cuentaSesion.impresiones++;
            cuentaSesion.paginas += e.paginas;
        }
        if (pantallaActiva() === 'sesion' || pantallaActiva() === 'retenidos') {
            repintarSiSePuede();
        }
    }
}

function ritmoHistorial() {
    return sesion.activa() || sesion.enGracia() || diagnostico.pruebaActiva()
        ? config.HISTORIAL_CON_SESION_MS
        : config.HISTORIAL_SIN_SESION_MS;
}

/* ------------------------------------------------------------------ */
/* Recuperación del panel                                               */
/* ------------------------------------------------------------------ */

/** Nunca durante el reposo (deja el panel bloqueado) ni en ráfaga. */
function repintarSiSePuede(forzar) {
    if (!ultimosWidgets || enReposo()) {
        return false;
    }
    if (!forzar && Date.now() - ultimoPintado < config.REPINTADO_HUECO_MIN_MS) {
        return false;
    }
    return repintar();
}

function instalarRecuperacion() {
    // Volver a la app (su icono o la tecla Inicio) es lo que la saca del modo "fuera".
    try {
        process.on_front = guard('alFrente', () => {
            if (tiempoFuera() >= 0) console.log('[app] vuelve a la app (on_front) tras ' + Math.round(tiempoFuera() / 1000) + ' s fuera');
            volvioALaApp();
            repintarSiSePuede(true);
        });
    } catch (e) { /* noop */ }
    try {
        new KeyCtrl().setCallBackFunc(9, 0, guard('teclaCasa', () => {
            if (tiempoFuera() >= 0) console.log('[app] vuelve a la app (tecla Inicio) tras ' + Math.round(tiempoFuera() / 1000) + ' s fuera');
            volvioALaApp();
            repintarSiSePuede(true);
        }));
    } catch (e) { /* noop */ }
    escucharDespertar(() => {
        setTimeout(guard('despertar', () => repintarSiSePuede(true)), config.REPINTADO_TRAS_DESPERTAR_MS);
    });
    setInterval(guard('repintado', () => {
        // Red de seguridad por si el equipo nunca avisa de la vuelta: sin nadie dentro y
        // pasado un buen rato, se recupera el panel como antes.
        if (tiempoFuera() > config.FUERA_MAX_MS && !sesion.activa()) {
            console.log('[app] fuera sin sesión más de ' + (config.FUERA_MAX_MS / 1000) + ' s: se recupera el panel');
            volvioALaApp();
        }
        repintarSiSePuede(false);
    }), config.REPINTADO_MS);
}

/* ------------------------------------------------------------------ */
/* Arranque                                                             */
/* ------------------------------------------------------------------ */

function arrancar() {
    conectarDibujo(dibujar);
    try { panel.setScreenBrightness(100); } catch (e) { /* noop */ }
    mostrar('inicio', renderInicio);   // dibujar SIEMPRE lo primero
    try { instalarRecuperacion(); } catch (e) { console.log('[arranque] recuperación: ' + (e && e.message)); }

    // Sin nadie dentro: bloquear si toca, o desbloquear lo que quedó de antes.
    try {
        const r = sesion.reposo();
        avisoCerradura = r.ok ? null : 'No se pudo bloquear: ' + r.resumen;
    } catch (e) {
        avisoCerradura = 'Error en la cerradura: ' + (e && e.message);
    }
    refrescarCerradura();

    historial.activar();
    fijarBaseHistorial();
    if (!historial.disponible()) {
        console.log('[arranque] este firmware no expone el historial: no se puede contar');
    }
    historial.vigilar(alTrabajo, ritmoHistorial, config.HISTORIAL_CON_SESION_MS);
    try {
        vigia.iniciar();
        estados.iniciar();
        vigia.guardian(decidirGuardian);
    } catch (e) { console.log('[arranque] vigía: ' + (e && e.message)); }
    try {
        web.instalar();
        // Un cambio de modo o de bloqueo hecho desde la web tiene que verse en el panel.
        acciones.alCambiar(() => {
            refrescarCerradura();
            if (pantallaActiva() === 'inicio') {
                repintarSiSePuede(true);
            }
        });
    } catch (e) { console.log('[arranque] web: ' + (e && e.message)); }

    setInterval(guard('reloj', () => {
        if (sesion.vencida()) {
            terminar('tiempo');
            return;
        }
        const p = pantallaActiva();
        if (p === 'sesion' || p === 'retenidos') {
            repintarSiSePuede(false);
        }
    }), 10000);

    repintar();
    const a = store.ajustes();
    console.log('[arranque] listo · modo ' + a.modo + ' · bloqueo ' + (a.bloqueoActivo ? 'ON' : 'off')
        + ' · impresión desde PC ' + (bloqueado === null ? '¿?' : bloqueado ? 'bloqueada' : 'abierta')
        + ' · usuarios ' + store.usuarios().length);
}

try {
    arrancar();
} catch (e) {
    console.log('[FATAL] ' + (e && e.message));
}
