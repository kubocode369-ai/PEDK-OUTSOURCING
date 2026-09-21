/**
 * PRUEBA DE CAPACIDAD: ¿cuántos usuarios aguanta la impresora?
 *
 * Lo que limita no es sólo si "cabe": cada vez que se cuenta un trabajo o se toca un
 * usuario, store.js reescribe el registro ENTERO dos veces (dos ficheros de
 * Object.save). Si con muchos usuarios eso tarda segundos, el panel y el guardián se
 * quedan parados ese tiempo. Así que se mide las dos cosas: hasta dónde se guarda y se
 * relee bien, y cuánto tarda.
 *
 * Se prueba con datos IGUALES a los reales (usuario, huella, nombre completo, cédula,
 * contadores, registro lleno), en ficheros PROPIOS: los datos de verdad no se tocan.
 * Tampoco setUserDefinedData, que sobrescribiría la copia real. Va en segundo plano,
 * paso a paso con pausas, para que la web y el panel sigan respondiendo entre medias;
 * se para al primer fallo, en cuanto un guardado pasa de LENTO_MS, o en el último paso.
 * Al terminar borra sus ficheros.
 */
import { guard } from './guard.js';

export const PASOS = [100, 250, 500, 1000, 1500, 2000, 3000, 4000, 5000];
export const LENTO_MS = 2000;
let pausaMs = 1500;

/** Sólo para las pruebas: sin pausas entre pasos. */
export function _pausa(ms) {
    pausaMs = ms;
}
const FICHEROS = ['/storage/prueba-capacidad.json', 'prueba-capacidad.json'];

let estado = { enCurso: false, pasos: [], fin: null };

export function estadoPrueba() {
    return estado;
}

/** Datos con la forma y el tamaño de los reales, para `n` personas. */
export function datosFalsos(n) {
    const usuarios = [];
    const contadores = {};
    for (let i = 0; i < n; i++) {
        const nombre = 'usuario.' + String(i).padStart(5, '0');
        usuarios.push({
            nombre,
            huella: (0x10000000 + i * 7919).toString(16) + (0x20000000 + i * 104729).toString(16),
            activo: true,
            creado: '2026-09-21T12:00:00.000Z',
            cedula: String(1700000000 + i),
            nombreCompleto: 'Nombre Segundo Apellido Apellido ' + i,
        });
        contadores[nombre] = { impresiones: 120 + i, paginas: 1500 + i, copias: 30, paginasCopia: 400 };
    }
    const registro = [];
    for (let i = 0; i < 60; i++) {
        registro.push({ hora: '2026-09-21 12:00:00', quien: 'usuario.00001', tipo: 'PRINT', paginas: 3,
            doc: 'Documento de prueba número ' + i + '.pdf', estado: 'COMPLETED', origen: 'PC-OFICINA' });
    }
    const vistos = [];
    for (let i = 0; i < 200; i++) vistos.push('j' + (100000 + i));
    return { version: 1, usuarios, contadores, registro, vistos, historialIniciado: true,
        ajustes: { modo: 'retencion', bloqueoActivo: true, bloquearCopia: true, minutosSesion: 3,
            huellaAdmin: 'abcdef0123456789', respaldoIp: '192.168.0.100' } };
}

function ahora() {
    return Date.now();
}

/** Un paso: guardar como store.js (dos ficheros), releer y comprobar. */
export function medirPaso(n) {
    const O = globalThis.Object;
    const d = datosFalsos(n);
    const t0 = ahora();
    const bytes = JSON.stringify(d).length;   // todo ASCII: caracteres = bytes
    const t1 = ahora();
    const r = { n, kb: Math.round(bytes / 1024), msJson: t1 - t0, msGuardar: null, msLeer: null, ok: false, error: null };
    try {
        for (const f of FICHEROS) O.save(f, d);
        const t2 = ahora();
        r.msGuardar = t2 - t1;
        const l = O.load(FICHEROS[0]);
        r.msLeer = ahora() - t2;
        r.ok = !!(l && Array.isArray(l.usuarios) && l.usuarios.length === n
            && l.usuarios[n - 1].nombre === d.usuarios[n - 1].nombre
            && l.contadores[d.usuarios[n - 1].nombre].paginas === 1500 + n - 1);
        if (!r.ok) r.error = 'no se relee igual';
    } catch (e) {
        r.error = String((e && e.message) || e).slice(0, 80);
    }
    return r;
}

function limpiar() {
    const s = globalThis.pedk && pedk.device && pedk.device.storage;
    for (const f of FICHEROS) {
        // Primero se deja pequeño (por si borrar no funciona) y luego se intenta borrar.
        try { globalThis.Object.save(f, {}); } catch (e) { /* noop */ }
        try { if (s && typeof s.deleteStorageFile === 'function') s.deleteStorageFile(f); } catch (e) { /* noop */ }
    }
}

/** Arranca la prueba. No espera: el resultado se consulta con estadoPrueba(). */
export function empezar(alTerminar) {
    if (estado.enCurso) {
        return false;
    }
    if (typeof globalThis.Object.save !== 'function' || typeof globalThis.Object.load !== 'function') {
        estado = { enCurso: false, pasos: [], fin: 'este equipo no tiene Object.save' };
        return false;
    }
    estado = { enCurso: true, pasos: [], fin: null };
    console.log('[capacidad] empieza');
    let i = 0;
    const siguiente = guard('capacidad', () => {
        let r;
        try {
            r = medirPaso(PASOS[i]);
        } catch (e) {
            // Por ejemplo, sin memoria para montar los datos: también es un límite.
            r = { n: PASOS[i], kb: null, msJson: null, msGuardar: null, msLeer: null, ok: false,
                error: String((e && e.message) || e).slice(0, 80) };
        }
        estado.pasos.push(r);
        console.log('[capacidad] ' + r.n + ' usuarios · ' + r.kb + ' KB · json ' + r.msJson + ' ms · guardar '
            + r.msGuardar + ' ms · leer ' + r.msLeer + ' ms · ' + (r.ok ? 'ok' : 'FALLA ' + r.error));
        i++;
        let fin = null;
        if (!r.ok) fin = 'falló con ' + r.n + ' usuarios: ' + r.error;
        else if (r.msGuardar > LENTO_MS) fin = 'demasiado lento con ' + r.n + ' usuarios';
        else if (i >= PASOS.length) fin = 'llegó al máximo probado (' + r.n + ' usuarios) sin problemas';
        if (fin) {
            limpiar();
            estado.enCurso = false;
            estado.fin = fin;
            console.log('[capacidad] fin: ' + fin);
            if (alTerminar) alTerminar(estado);
            return;
        }
        setTimeout(siguiente, pausaMs);
    });
    setTimeout(siguiente, Math.min(200, pausaMs));
    return true;
}
