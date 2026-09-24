/**
 * COPIAR DESDE LA APP, sin salir al menú del equipo.
 *
 * Hasta ahora copiar era "Ir a copiar": la persona se iba al menú de la impresora y
 * nosotros nos enterábamos después, mirando el historial. Con `pedk.jobs.copy` el
 * trabajo lo lanza la app, así que la persona no se va a ninguna parte y sabemos
 * cuándo empieza y cuándo acaba.
 *
 * Medido en la BM5220ADW el 24/25-09-2026: `pedk.jobs.copy` trae 84 piezas, entre
 * ellas `CopyJob`, `CopyParameterSet`, `Copies`, `CopyMode` y `CopyScanSource`.
 * `new CopyJob('COPY_NORMAL')` funciona y nace en `JBSts_Init`. OJO: este firmware
 * NO exporta la constante `COPY_SCAN_SOURCE` (sí la clase), así que la clave se pide
 * con `clave()`, que cae al literal — igual que en cerradura.js.
 *
 * Lo que NO hace esta pantalla, a propósito: contar. De eso sigue encargándose el
 * historial (historial.js + app.js), que ya funciona y es la única fuente de verdad
 * sobre las páginas que salieron de verdad.
 */
import { COLOR, ambito, boton, etiqueta, pantalla, recortar } from './ui.js';
import { mostrar, repintar, pantallaActiva } from './router.js';
import { guard } from './guard.js';
import * as estados from './estados.js';

/**
 * Los orígenes del documento. Los números son del SDK (0 Auto, 1 DADF, 2 ADF, 3 FB,
 * 4 MADF); este equipo declara `Scan_Type: ["FB","ADF"]`, así que sólo se ofrecen los
 * tres que puede cumplir.
 */
const ORIGENES = [
    { valor: 0, nombre: 'Automático' },
    { valor: 3, nombre: 'Platina' },
    { valor: 2, nombre: 'Alimentador' },
];
const MAX_COPIAS = 99;

let alVolver = null;
let copias = 1;
let iOrigen = 0;
/**
 * ¿Deja este firmware elegir de dónde se lee el original?
 *
 * MEDIDO el 25-09-2026: NO. `addParameter('COPY_SCAN_SOURCE', …)` lanza `EOPNOTSUPP`
 * en la BM5220ADW (exporta la clase `CopyScanSource` pero no acepta el parámetro), y
 * el equipo decide solo: alimentador si hay hojas, si no el cristal. Un botón que no
 * hace nada engaña, así que sólo se enseña si el equipo acepta el parámetro. Se
 * pregunta una vez y se recuerda: si Pantum lo habilita, aparece sin tocar el código.
 */
let soportaOrigen = null;
let trabajo = null;
/** 'listo' | 'copiando' */
let estado = 'listo';
let mensaje = '';
let colorMensaje = COLOR.suave;
/** Número de orden del trabajo: el firmware lo pide y sólo tiene que ser distinto. */
let woNum = 1;

function ns() {
    return (globalThis.pedk && pedk.jobs && pedk.jobs.copy) || null;
}

/** ¿Este firmware sabe copiar desde la app? */
export function disponible() {
    const c = ns();
    return !!(c && typeof c.CopyJob === 'function' && typeof c.CopyParameterSet === 'function');
}

/** Las constantes del SDK valen su propio nombre: si no está exportada, se usa el literal. */
function clave(nombre) {
    const c = ns();
    return (c && c[nombre]) || nombre;
}

/**
 * Añade un parámetro y DEJA EN EL LOG lo que contestó el equipo. Si una clase o una
 * clave no le gustan, la copia sale igual con los valores de fábrica: más vale copiar
 * en automático que no copiar.
 */
function ponerParametro(param, nombreClave, nombreClase, valor) {
    const c = ns();
    if (!c || typeof c[nombreClase] !== 'function') {
        console.log('[copia] sin ' + nombreClase + ': no se pide ' + nombreClave);
        return false;
    }
    try {
        const r = param.addParameter(clave(nombreClave), new c[nombreClase](valor));
        console.log('[copia] ' + nombreClave + '=' + valor + ' -> ' + r);
        return r !== false;
    } catch (e) {
        console.log('[copia] ' + nombreClave + ' lanzó: ' + String((e && e.message) || e).slice(0, 50));
        return false;
    }
}

/** Pregunta UNA vez si el equipo acepta elegir el origen. No lanza nada al equipo. */
function preguntarOrigen() {
    if (soportaOrigen !== null) {
        return soportaOrigen;
    }
    const c = ns();
    soportaOrigen = false;
    if (!c || typeof c.CopyScanSource !== 'function' || typeof c.CopyParameterSet !== 'function') {
        console.log('[copia] origen del documento: el equipo no trae CopyScanSource');
        return soportaOrigen;
    }
    try {
        const r = new c.CopyParameterSet().addParameter(clave('COPY_SCAN_SOURCE'), new c.CopyScanSource(0));
        soportaOrigen = r !== false;
        console.log('[copia] origen del documento: ' + (soportaOrigen ? 'se puede elegir' : 'lo decide el equipo (' + r + ')'));
    } catch (e) {
        console.log('[copia] origen del documento: lo decide el equipo ('
            + String((e && e.message) || e).slice(0, 30) + ')');
    }
    return soportaOrigen;
}

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

/** Suelta el trabajo y su oyente: si no, el siguiente recibe los avisos del anterior. */
function soltar() {
    if (trabajo && trabajo.oyente) {
        try {
            trabajo.job.removeListener(trabajo.oyente);
        } catch (e) { /* al equipo le da igual: el trabajo ya terminó */ }
    }
    trabajo = null;
    estado = 'listo';
}

/** Un aviso del EQUIPO: atasco, tapa abierta, sin tóner… manda sobre el nuestro. */
function alEstadoEquipo(m) {
    decir(m.texto, m.color);
    if (pantallaActiva() === 'copia') {
        repintar();
    }
}

/** Llega un estado del TRABAJO (JBSts_*). */
function alEstado(bruto) {
    const s = String(bruto);
    console.log('[copia] estado: ' + s);
    if (s.indexOf('Running') >= 0) {
        estado = 'copiando';
        decir('Copiando…', COLOR.texto);
    } else if (s.indexOf('Finish') >= 0) {
        soltar();
        decir('Copia hecha.', COLOR.ok);
    } else if (s.indexOf('Cancel') >= 0 || s.indexOf('Abort') >= 0) {
        soltar();
        decir('Copia cancelada.', COLOR.aviso);
    } else if (s.indexOf('Suspend') >= 0 || s.indexOf('Pause') >= 0) {
        decir('El equipo ha parado la copia. Mire su pantalla.', COLOR.peligro);
    }
    if (pantallaActiva() === 'copia') {
        repintar();
    }
}

/**
 * El firmware avisa llamando a `notify` del oyente. El ejemplo del SDK lo pone en el
 * PROTOTIPO y nuestro vigía lo pone en la instancia: aquí se ponen los dos, porque
 * cuál de las dos formas llega en este equipo no está medido y perderse el aviso
 * dejaría la pantalla colgada en "Copiando…".
 */
function crearOyente() {
    const c = ns();
    const Clase = c && c.JobStateListener;
    const avisar = guard('copiaEstado', alEstado);
    if (typeof Clase === 'function') {
        Clase.prototype.notify = function notify(e) { avisar(e); };
        try {
            const o = new Clase();
            o.notify = avisar;
            return o;
        } catch (e) { /* se sigue con un objeto llano */ }
    }
    return { notify: avisar };
}

function copiar() {
    const c = ns();
    if (estado === 'copiando' || !c) {
        return;
    }
    let param = null;
    try {
        param = new c.CopyParameterSet();
    } catch (e) {
        decir('El equipo no admite copiar desde aquí.', COLOR.peligro);
        console.log('[copia] CopyParameterSet lanzó: ' + String((e && e.message) || e).slice(0, 50));
        repintar();
        return;
    }
    ponerParametro(param, 'COPY_PARAM_COPIES', 'Copies', copias);
    if (preguntarOrigen()) {
        ponerParametro(param, 'COPY_SCAN_SOURCE', 'CopyScanSource', ORIGENES[iOrigen].valor);
    }

    let job = null;
    try {
        job = new c.CopyJob('COPY_NORMAL');
    } catch (e) {
        decir('No se pudo preparar la copia.', COLOR.peligro);
        console.log('[copia] new CopyJob lanzó: ' + String((e && e.message) || e).slice(0, 50));
        repintar();
        return;
    }
    const oyente = crearOyente();
    try {
        job.addListener(oyente);
    } catch (e) {
        console.log('[copia] addListener lanzó: ' + String((e && e.message) || e).slice(0, 50));
    }
    trabajo = { job, oyente };
    estado = 'copiando';
    decir('Copiando…', COLOR.texto);
    repintar();

    let r = null;
    try {
        r = job.start(woNum++, param, null);
    } catch (e) {
        r = 'lanzó ' + String((e && e.message) || e).slice(0, 40);
    }
    console.log('[copia] start(' + copias + ' copia(s), origen ' + ORIGENES[iOrigen].nombre + ') -> ' + r);
    // 0 es "arrancó". Cualquier otra cosa es un no: el equipo está ocupado, sin papel,
    // o no acepta la orden. No se deja la pantalla esperando un aviso que no vendrá.
    if (r !== 0) {
        soltar();
        decir(r === 4 ? 'El equipo está ocupado. Inténtelo en unos segundos.'
            : 'No se pudo copiar (' + r + '). Mire la pantalla del equipo.', COLOR.peligro);
        repintar();
    }
}

function cancelar() {
    if (!trabajo) {
        return;
    }
    // El aviso se pone ANTES: si el equipo contesta en el acto (y contesta), su
    // "Copia cancelada" llega dentro de cancel() y ponerlo después lo pisaría.
    decir('Cancelando…', COLOR.aviso);
    try {
        trabajo.job.cancel();
    } catch (e) {
        console.log('[copia] cancel lanzó: ' + String((e && e.message) || e).slice(0, 50));
        soltar();
        decir('No se pudo cancelar. Use el botón del equipo.', COLOR.peligro);
    }
    repintar();
}

function render() {
    ambito('cp');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 24, 'Copiar', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 32, 'Volver', COLOR.acento, () => {
        // Volver no cancela: la copia sigue y se cuenta igual. Sólo se deja de mirar.
        soltar();
        estados.olvidar(alEstadoEquipo);
        if (alVolver) {
            alVolver();
        }
    }));

    const copiando = estado === 'copiando';
    w.push(etiqueta('lc', 24, 74, 120, 24, 'Copias', COLOR.texto));
    w.push(boton('menos', 150, 62, 62, 44, '−', COLOR.acento, () => {
        copias = Math.max(1, copias - 1);
        repintar();
    }));
    w.push(etiqueta('n', 222, 74, 70, 24, String(copias), COLOR.texto, 'center'));
    w.push(boton('mas', 300, 62, 62, 44, '+', COLOR.acento, () => {
        copias = Math.min(MAX_COPIAS, copias + 1);
        repintar();
    }));

    if (preguntarOrigen()) {
        w.push(etiqueta('lo', 24, 134, 120, 24, 'Origen', COLOR.texto));
        w.push(boton('origen', 150, 124, 212, 40, ORIGENES[iOrigen].nombre, COLOR.acento, () => {
            iOrigen = (iOrigen + 1) % ORIGENES.length;
            repintar();
        }));
    } else {
        // Sin elección: se dice de dónde va a leer, para que nadie deje la hoja donde no es.
        w.push(etiqueta('lo', 24, 134, 440, 22,
            'Lee del alimentador si hay hojas; si no, del cristal.', COLOR.tenue));
    }

    w.push(copiando
        ? boton('cancelar', 140, 186, 200, 54, 'Cancelar', COLOR.peligro, cancelar)
        : boton('copiar', 140, 186, 200, 54, 'COPIAR', COLOR.ok, copiar));

    w.push(etiqueta('msg', 12, 256, 456, 44, recortar(mensaje, 62), colorMensaje));
    return w;
}

/** Abre la pantalla. `volver` es lo que hay que hacer al salir. */
export function abrirCopia(volver) {
    alVolver = volver;
    estados.alCambiar(alEstadoEquipo);
    // Se vuelve a preguntar en cada apertura (cuesta un objeto, no toca al equipo): así
    // un firmware nuevo que ya acepte el origen enseña el botón sin reinstalar nada.
    soportaOrigen = null;
    preguntarOrigen();
    if (estado !== 'copiando') {
        // La impresora es de todos: cada vez que se abre la pantalla se empieza de cero.
        // Si no, el siguiente se encuentra las 5 copias que puso el anterior.
        copias = 1;
        iOrigen = 0;
        decir('', COLOR.suave);
    }
    mostrar('copia', render);
}
