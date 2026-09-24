/**
 * Diagnóstico: qué implementa DE VERDAD este firmware, en una sola instalación.
 *
 * Cada duda sobre el equipo cuesta un ciclo de compilar, firmar, instalar y probar
 * con alguien delante. Así que todo lo que esta app necesita saber se pregunta aquí
 * de una vez, se pinta en el panel y se deja en la consola con el prefijo [diag].
 *
 * Y la pregunta que ninguna lectura contesta —¿apagar el interruptor impide imprimir
 * desde un PC?— se contesta con la PRUEBA DE CERRADURA: bloquea el equipo unos
 * minutos; quien la hace manda una impresión desde su PC; si en el historial aparece
 * un trabajo mientras dura, la cerradura no sirve. Enumerar dice qué exporta el
 * firmware, no qué acepta: para eso hay que intentarlo.
 */
import { config } from './config.js';
import { COLOR, ambito, boton, etiqueta, pantalla, paginador, paginar, recortar } from './ui.js';
import { mostrar, repintar, pantallaActiva } from './router.js';
import { guard } from './guard.js';
import * as cerradura from './cerradura.js';
import * as historial from './historial.js';
import * as retencion from './retencion.js';
import * as store from './store.js';
import * as vigia from './vigia.js';
import * as estados from './estados.js';
import * as explorar from './explorar.js';
import * as web from './web.js';

const LINEAS_POR_PAGINA = 9;

let alVolver = null;
let lineas = [];
let pagina = 0;
let mensaje = '';
let colorMensaje = COLOR.suave;

/** {hasta, fugas: [entrada], cierre} mientras dura la prueba de cerradura. */
let prueba = null;
let ultimoResultado = null;

export function pruebaActiva() {
    return prueba !== null;
}

/** La llama app.js con cada trabajo que aparece sin sesión durante la prueba. */
export function anotarFuga(entrada) {
    if (prueba) {
        prueba.fugas.push(entrada);
        console.log('[diag] TRABAJO CON EL EQUIPO BLOQUEADO: #' + entrada.id + ' ' + entrada.tipo
            + ' ' + entrada.estado + ' ' + entrada.paginas + ' pag');
        if (pantallaActiva() === 'diagnostico') {
            repintar();
        }
    }
}

function si(v) {
    return v ? 'sí' : 'no';
}

/** Todo lo que se sabe del equipo, en líneas cortas. */
export function informe() {
    const out = [];
    const s = globalThis.pedk && pedk.device && pedk.device.setting;
    out.push('Interruptores: ' + si(cerradura.disponible())
        + ' · FUNCTION_TYPE ' + si(!!(s && s.FUNCTION_TYPE)));
    const nombres = cerradura.INTERRUPTORES.IMPRESION
        .concat(cerradura.INTERRUPTORES.COPIA, ['FUNC_T_SECURE_PRINT', 'FUNC_T_UDISK_PRINT']);
    for (const n of nombres) {
        out.push(n.replace('FUNC_T_', '') + ': ' + cerradura.leerCrudo(n)
            + (cerradura.exportado(n) ? '' : ' (no exportado)'));
    }

    const j = globalThis.pedk && pedk.jobctl;
    const entradas = historial.leerEntradas();
    out.push('Historial: lista ' + si(j && typeof j.getJobHistoryList === 'function')
        + ' · ultima ' + si(j && typeof j.getJobLastHistory === 'function')
        + ' · ' + entradas.length + ' trab.');
    const u = entradas[entradas.length - 1];
    if (u) {
        out.push('Ultimo: #' + u.id + ' ' + u.tipo + ' ' + u.estado + ' ' + u.paginas + 'p '
            + (u.origen || ''));
    }

    out.push(...vigia.informe());
    out.push(...estados.informe());
    out.push(...web.informe());

    const ret = retencion.disponible();
    out.push('Retencion: ' + ret.detalle);
    if (ret.ok) {
        out.push('Retenidos: ' + (retencion.nombresConTrabajos().join(',') || 'ninguno'));
    }

    const st = globalThis.pedk && pedk.device && pedk.device.storage;
    const mem = store.estado();
    out.push('Memoria: ' + si(st && typeof st.setUserDefinedData === 'function')
        + (mem.soloLectura ? ' · SOLO LECTURA: ' + mem.motivo : ' · escribe'));
    out.push('Salir al menu: draw_exit ' + si(typeof globalThis.js_screenctrl_draw_exit === 'function')
        + ' · on_back ' + si(globalThis.process && typeof process.on_back === 'function'));

    const a = store.ajustes();
    const sin = store.contadorDe(store.SIN_SESION);
    out.push('Modo ' + a.modo + ' · bloqueo ' + (a.bloqueoActivo ? 'ON' : 'off')
        + ' · sin sesion: ' + (sin.impresiones + sin.copias + sin.escaneos) + ' trab.');
    if (ultimoResultado) {
        out.push('Prueba: ' + ultimoResultado);
    }
    out.forEach((l) => console.log('[diag] ' + l));
    return out;
}

export function abrirDiagnostico(volver) {
    alVolver = volver;
    pagina = 0;
    mensaje = '';
    lineas = informe();
    mostrar('diagnostico', render);
}

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

function render() {
    ambito('dg');
    const info = paginar(lineas, pagina, LINEAS_POR_PAGINA);
    pagina = info.pagina;
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 230, 22, 'Diagnóstico del equipo', COLOR.texto));
    w.push(boton('trabajos', 250, 6, 118, 30, 'Trabajos', COLOR.acento, () => vigia.abrirVigia(() => {
        lineas = informe();
        mostrar('diagnostico', render);
    })));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => alVolver && alVolver()));
    info.items.forEach((l, i) => {
        w.push(etiqueta('l' + i, 12, 40 + i * 20, 456, 20, recortar(l, 62), COLOR.texto));
    });
    w.push(...paginador('p', 12, 226, info, () => { pagina--; repintar(); }, () => { pagina++; repintar(); }));
    w.push(boton('datos', 302, 226, 166, 30, 'Probar memoria', COLOR.acento, () => {
        lineas = explorar.probarDatos();
        pagina = 0;
        decir('Guarde el log: líneas [explorar]', COLOR.aviso);
        repintar();
    }));
    if (prueba) {
        const seg = Math.max(0, Math.ceil((prueba.hasta - Date.now()) / 1000));
        w.push(etiqueta('pr', 12, 264, 456, 22,
            'BLOQUEADO ' + seg + ' s · imprima desde un PC · colados: ' + prueba.fugas.length,
            prueba.fugas.length ? COLOR.peligro : COLOR.aviso));
    } else {
        w.push(boton('probar', 12, 260, 110, 32, 'Bloqueo', COLOR.acento, iniciarPrueba));
        w.push(boton('releer', 128, 260, 110, 32, 'Releer', COLOR.acento, () => {
            lineas = informe();
            decir('Leído de nuevo', COLOR.ok);
            repintar();
        }));
        w.push(boton('explorar', 244, 260, 110, 32, 'SDK', COLOR.acento, () => {
            lineas = explorar.volcar();
            pagina = 0;
            decir('Guarde el log: líneas [explorar]', COLOR.aviso);
            repintar();
        }));
        // Medición de copia/escaneo/cuotas: sólo lee, no lanza ningún trabajo.
        w.push(boton('medir', 360, 260, 110, 32, 'Copia/Esc', COLOR.acento, () => {
            lineas = explorar.medirTrabajos();
            pagina = 0;
            decir('Guarde el log: líneas [explorar]', COLOR.aviso);
            repintar();
        }));
    }
    w.push(etiqueta('msg', 12, 296, 456, 20, recortar(mensaje, 62), colorMensaje));
    return w;
}

function iniciarPrueba() {
    if (prueba) {
        return;
    }
    const r = cerradura.cerrar({ impresion: true, copia: false });
    if (!r.ok) {
        cerradura.abrir({ impresion: true, copia: false });
        ultimoResultado = 'no se pudo bloquear (' + r.resumen + ')';
        decir('No se pudo bloquear: ' + r.resumen, COLOR.peligro);
        lineas = informe();
        repintar();
        return;
    }
    prueba = { hasta: Date.now() + config.PRUEBA_CERRADURA_MS, fugas: [], cierre: r };
    console.log('[diag] prueba de cerradura: equipo bloqueado ' + (config.PRUEBA_CERRADURA_MS / 1000) + ' s');
    decir('Mande una impresión desde un PC ahora. No debería salir.', COLOR.aviso);
    repintar();
    setTimeout(guard('finPrueba', terminarPrueba), config.PRUEBA_CERRADURA_MS);
    const reloj = setInterval(guard('relojPrueba', () => {
        if (!prueba) {
            clearInterval(reloj);
        } else if (pantallaActiva() === 'diagnostico') {
            repintar();
        }
    }), 10000);
}

export function terminarPrueba() {
    if (!prueba) {
        return;
    }
    const fugas = prueba.fugas;
    prueba = null;
    // Si el administrador tiene el bloqueo encendido, el equipo se queda como estaba.
    if (!store.ajustes().bloqueoActivo) {
        cerradura.abrir({ impresion: true, copia: false });
    }
    ultimoResultado = fugas.length === 0
        ? 'nada salió bloqueado (¿mandó un trabajo?)'
        : fugas.length + ' trabajo(s) registrados bloqueado: ' + fugas.map((f) => f.estado + '/' + f.paginas + 'p').join(' ');
    console.log('[diag] fin de la prueba: ' + ultimoResultado);
    decir('Prueba terminada: ' + ultimoResultado, fugas.some((f) => f.paginas > 0) ? COLOR.peligro : COLOR.ok);
    lineas = informe();
    if (pantallaActiva() === 'diagnostico') {
        repintar();
    }
}
