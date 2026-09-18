/**
 * AJUSTES (sólo con PIN de administrador): usuarios, contadores, bloqueo y modo.
 *
 * El bloqueo viene APAGADO de fábrica a propósito. Encenderlo antes de tener usuarios
 * dados de alta y la cerradura probada en el diagnóstico deja la impresora sin poder
 * imprimir para nadie. Y "Desbloquear equipo" no pregunta nada: es la salida de
 * emergencia, y también lo que hay que pulsar ANTES de desinstalar la app (los
 * interruptores del equipo no se restauran solos al quitarla).
 */
import { config } from './config.js';
import { COLOR, ambito, boton, etiqueta, pantalla, paginador, paginar, recortar, tecladoNumerico, tecladoTexto } from './ui.js';
import { mostrar, repintar } from './router.js';
import * as store from './store.js';
import * as cerradura from './cerradura.js';
import * as sesion from './sesion.js';
import * as retencion from './retencion.js';
import * as respaldo from './respaldo.js';
import { abrirDiagnostico } from './diagnostico.js';

let alSalir = null;
let vista = 'menu';
let pagina = 0;
let mensaje = '';
let colorMensaje = COLOR.suave;

/** Borrador de texto (nombre) y del PIN en dos pasos. */
let borrador = '';
let pinPaso = 1;
let pinPrimero = '';
let pinDestino = null;   // {titulo, guardar(pin) -> {ok, error}}
let confirmar = null;    // clave de la acción que pide un segundo toque

export function abrirAjustes(salir) {
    alSalir = salir;
    ir('menu');
    mostrar('ajustes', render);
}

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

function ir(v) {
    vista = v;
    pagina = 0;
    borrador = '';
    confirmar = null;
    decir('', COLOR.suave);
    repintar();
}

function render() {
    switch (vista) {
        case 'usuarios': return renderUsuarios();
        case 'nombre': return renderNombre();
        case 'pin': return renderPin();
        case 'respaldo': return renderRespaldo();
        case 'respaldoIp': return renderRespaldoIp();
        case 'contadores': return renderContadores();
        case 'registro': return renderRegistro();
        default: return renderMenu();
    }
}

/* ------------------------------------------------------------------ */
/* Menú                                                                 */
/* ------------------------------------------------------------------ */

function renderMenu() {
    ambito('ajm');
    const a = store.ajustes();
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 22, 'Ajustes', COLOR.texto));
    w.push(boton('salir', 376, 6, 92, 30, 'Salir', COLOR.acento, () => alSalir && alSalir()));

    // Seis filas apretadas para que quepa Respaldo sin sacrificar nada de lo que ya
    // había. El aviso y el mensaje bajan en consecuencia.
    const col = (i) => (i === 0 ? 12 : 244);
    const fila = (i) => 40 + i * 38;
    const W = 224;
    const H = 32;

    w.push(boton('usuarios', col(0), fila(0), W, H, 'Usuarios (' + store.usuarios().length + ')', COLOR.acento, () => ir('usuarios')));
    w.push(boton('contadores', col(1), fila(0), W, H, 'Contadores', COLOR.acento, () => ir('contadores')));
    w.push(boton('registro', col(0), fila(1), W, H, 'Últimos trabajos', COLOR.acento, () => ir('registro')));
    w.push(boton('diag', col(1), fila(1), W, H, 'Diagnóstico', COLOR.acento,
        () => abrirDiagnostico(() => { ir('menu'); mostrar('ajustes', render); })));

    w.push(boton('bloqueo', col(0), fila(2), W, H, a.bloqueoActivo ? 'Bloqueo: ENCENDIDO' : 'Bloqueo: apagado',
        a.bloqueoActivo ? COLOR.ok : COLOR.aviso, alternarBloqueo));
    w.push(boton('modo', col(1), fila(2), W, H, a.modo === 'sesion' ? 'Modo: sesión' : 'Modo: retención',
        COLOR.acento, alternarModo));

    w.push(boton('minutos', col(0), fila(3), W, H, 'Sesión: ' + a.minutosSesion + ' min', COLOR.acento, siguienteDuracion));
    w.push(boton('copia', col(1), fila(3), W, H, a.bloquearCopia ? 'Copia: con PIN' : 'Copia: libre',
        COLOR.acento, alternarCopia));

    w.push(boton('pinadmin', col(0), fila(4), W, H, 'Cambiar PIN admin', COLOR.acento, () => pedirPin({
        titulo: 'Nuevo PIN de administrador',
        guardar: (p) => (store.cambiarPinAdmin(p) ? { ok: true } : { ok: false, error: 'PIN no válido' }),
    })));
    w.push(boton('abrir', col(1), fila(4), W, H, 'Desbloquear equipo', COLOR.peligro, desbloquearTodo));

    const ip = respaldo.destino();
    w.push(boton('respaldo', col(0), fila(5), W, H, ip ? 'Respaldo: ' + ip : 'Respaldo: apagado',
        ip ? COLOR.acento : COLOR.aviso, () => ir('respaldo')));

    const aviso = store.pinAdminDeFabrica() ? 'PIN de admin de fábrica: cámbielo' : estadoCerradura();
    w.push(etiqueta('st', 12, 270, 456, 20, recortar(aviso, 62),
        store.pinAdminDeFabrica() ? COLOR.aviso : COLOR.tenue));
    w.push(etiqueta('msg', 12, 292, 456, 24, recortar(mensaje, 62), colorMensaje));
    return w;
}

function estadoCerradura() {
    const b = cerradura.impresionBloqueada();
    return 'Impresión desde PC: ' + (b === null ? 'no se sabe' : b ? 'bloqueada' : 'abierta');
}

function alternarBloqueo() {
    const a = store.ajustes();
    if (a.bloqueoActivo) {
        store.cambiarAjuste('bloqueoActivo', false);
        const r = cerradura.abrir();
        decir(r.ok ? 'Bloqueo apagado: cualquiera imprime' : r.resumen, r.ok ? COLOR.aviso : COLOR.peligro);
        repintar();
        return;
    }
    if (store.usuarios().filter((u) => u.activo !== false).length === 0) {
        decir('Dé de alta al menos un usuario antes', COLOR.peligro);
        repintar();
        return;
    }
    store.cambiarAjuste('bloqueoActivo', true);
    const r = sesion.reposo();
    if (!r.ok) {
        // Un bloqueo a medias es peor que ninguno: da falsa seguridad.
        store.cambiarAjuste('bloqueoActivo', false);
        cerradura.abrir();
        decir('No se pudo bloquear: ' + r.resumen, COLOR.peligro);
    } else if (a.modo === 'retencion') {
        decir('Activo: sólo se imprime con usuario y PIN', COLOR.ok);
    } else {
        decir('Bloqueado. Compruébelo con Diagnóstico > Probar', COLOR.ok);
    }
    repintar();
}

function alternarModo() {
    const a = store.ajustes();
    if (a.modo === 'retencion') {
        store.cambiarAjuste('modo', 'sesion');
        decir('Modo sesión: se desbloquea al entrar', COLOR.ok);
    } else {
        let d = retencion.disponible();
        if (!d.ok) {
            retencion.encenderFuncion();
            d = retencion.disponible();
        }
        if (!d.ok) {
            decir('Este equipo no retiene: ' + d.detalle, COLOR.peligro);
            repintar();
            return;
        }
        store.cambiarAjuste('modo', 'retencion');
        decir('Modo retención: el PC envía como confidencial', COLOR.ok);
    }
    sesion.reposo();
    repintar();
}

function siguienteDuracion() {
    const ops = config.MINUTOS_SESION_OPCIONES;
    const i = ops.indexOf(store.ajustes().minutosSesion);
    store.cambiarAjuste('minutosSesion', ops[(i + 1) % ops.length]);
    repintar();
}

function alternarCopia() {
    const a = store.ajustes();
    const nuevo = !a.bloquearCopia;
    store.cambiarAjuste('bloquearCopia', nuevo);
    if (a.bloqueoActivo) {
        const r = nuevo ? cerradura.cerrar({ impresion: false, copia: true }) : cerradura.abrir({ impresion: false, copia: true });
        decir(r.resumen, r.ok ? COLOR.ok : COLOR.peligro);
    } else {
        decir(nuevo ? 'Se aplicará al encender el bloqueo' : 'Copia libre', COLOR.suave);
    }
    repintar();
}

function desbloquearTodo() {
    store.cambiarAjuste('bloqueoActivo', false);
    const r = cerradura.abrir();
    decir(r.ok ? 'Equipo desbloqueado y bloqueo apagado' : r.resumen, r.ok ? COLOR.ok : COLOR.peligro);
    repintar();
}

/* ------------------------------------------------------------------ */
/* Usuarios                                                             */
/* ------------------------------------------------------------------ */

function renderUsuarios() {
    ambito('aju');
    const info = paginar(store.usuarios(), pagina, config.FILAS_POR_PAGINA);
    pagina = info.pagina;
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 22, 'Usuarios (' + info.total + ')', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => ir('menu')));
    if (info.total === 0) {
        w.push(etiqueta('vacio', 12, 70, 456, 22, 'Todavía no hay usuarios', COLOR.suave, 'center'));
    }
    let y = 44;
    for (const u of info.items) {
        const k = u.nombre;
        w.push(etiqueta('n' + k, 12, y + 8, 150, 20, recortar(k, 16), u.activo === false ? COLOR.tenue : COLOR.texto));
        w.push(boton('p' + k, 166, y + 2, 90, 32, 'PIN', COLOR.acento, () => pedirPin({
            titulo: 'Nuevo PIN de ' + k,
            guardar: (p) => (store.cambiarPinUsuario(k, p) ? { ok: true } : { ok: false, error: 'PIN no válido' }),
            volverA: 'usuarios',
        })));
        w.push(boton('a' + k, 262, y + 2, 100, 32, u.activo === false ? 'Activar' : 'Desactivar', COLOR.acento, () => {
            store.activarUsuario(k, u.activo === false);
            repintar();
        }));
        w.push(boton('q' + k, 368, y + 2, 100, 32, confirmar === 'q' + k ? '¿Seguro?' : 'Quitar', COLOR.peligro, () => {
            if (confirmar !== 'q' + k) {
                confirmar = 'q' + k;
            } else {
                store.quitarUsuario(k);
                confirmar = null;
                decir(k + ' quitado (sus contadores se conservan)', COLOR.ok);
            }
            repintar();
        }));
        y += 42;
    }
    w.push(...paginador('pg', 12, 216, info, () => { pagina--; repintar(); }, () => { pagina++; repintar(); }));
    w.push(boton('nuevo', 12, 252, 200, 34, '+ Nuevo usuario', COLOR.ok, () => ir('nombre')));
    w.push(etiqueta('msg', 12, 294, 456, 20, recortar(mensaje, 62), colorMensaje));
    return w;
}

function renderNombre() {
    ambito('ajn');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 6, 200, 22, 'Nombre de usuario', COLOR.texto));
    w.push(boton('cancelar', 238, 4, 110, 32, 'Cancelar', COLOR.suave, () => ir('usuarios')));
    w.push(boton('seguir', 356, 4, 112, 32, 'Siguiente', COLOR.ok, () => {
        const n = store.normalizarUsuario(borrador);
        if (!store.usuarioValido(n)) {
            decir('Escriba un nombre (a-z, 0-9, . _ -)', COLOR.peligro);
            repintar();
            return;
        }
        if (store.usuarios().some((u) => u.nombre === n)) {
            decir('Ese usuario ya existe', COLOR.peligro);
            repintar();
            return;
        }
        pedirPin({
            titulo: 'PIN de ' + n,
            guardar: (p) => store.agregarUsuario(n, p),
            volverA: 'usuarios',
        });
    }));
    w.push(etiqueta('v', 12, 44, 456, 30, borrador || '_', COLOR.acento, 'center'));
    w.push(etiqueta('msg', 12, 80, 456, 20, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(...tecladoTexto('kb', 156, (t) => {
        if (t === '<') {
            borrador = borrador.slice(0, -1);
        } else if (borrador.length < config.USUARIO_MAX) {
            borrador += t;
        }
        decir('', COLOR.suave);
        repintar();
    }));
    return w;
}

/* ------------------------------------------------------------------ */
/* PIN en dos pasos (escribir y repetir)                                */
/* ------------------------------------------------------------------ */

function pedirPin(destino) {
    pinDestino = destino;
    pinPaso = 1;
    pinPrimero = '';
    vista = 'pin';
    borrador = '';
    decir('', COLOR.suave);
    repintar();
}

function renderPin() {
    ambito('ajp');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 456, 22, recortar(pinDestino.titulo, 40), COLOR.texto, 'center'));
    w.push(etiqueta('h', 12, 30, 456, 18,
        pinPaso === 1 ? 'De ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos' : 'Repítalo para confirmar',
        COLOR.tenue, 'center'));
    w.push(etiqueta('v', 140, 50, 200, 26, '*'.repeat(borrador.length), COLOR.acento, 'center'));
    w.push(...tecladoNumerico('np', 90, 80, teclaPin));
    w.push(etiqueta('msg', 12, 254, 456, 22, recortar(mensaje, 62), colorMensaje, 'center'));
    w.push(boton('volver', 12, 282, 110, 32, 'Volver', COLOR.suave, () => ir(pinDestino.volverA || 'menu')));
    return w;
}

function teclaPin(t) {
    if (t === 'C') {
        borrador = '';
    } else if (t !== 'OK') {
        if (borrador.length < config.PIN_MAX) {
            borrador += t;
        }
    } else if (!store.pinValido(borrador)) {
        decir('Use de ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos', COLOR.peligro);
    } else if (pinPaso === 1) {
        pinPrimero = borrador;
        pinPaso = 2;
        borrador = '';
        decir('', COLOR.suave);
    } else if (borrador !== pinPrimero) {
        pinPaso = 1;
        pinPrimero = '';
        borrador = '';
        decir('No coinciden. Empiece de nuevo', COLOR.peligro);
    } else {
        const r = pinDestino.guardar(borrador);
        const destino = pinDestino.volverA || 'menu';
        if (r.ok) {
            ir(destino);
            decir('Guardado', COLOR.ok);
        } else {
            pinPaso = 1;
            borrador = '';
            decir(r.error || 'No se pudo guardar', COLOR.peligro);
        }
    }
    repintar();
}

/* ------------------------------------------------------------------ */
/* Respaldo por red                                                     */
/* ------------------------------------------------------------------ */

function renderRespaldo() {
    ambito('ajb');
    const e = respaldo.estado();
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 22, 'Respaldo por red', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => ir('menu')));

    w.push(etiqueta('d', 12, 40, 456, 20,
        e.destino ? 'PC de respaldo: ' + e.destino + ':' + config.RESPALDO_PUERTO : 'Sin PC configurado: el respaldo está apagado',
        e.destino ? COLOR.texto : COLOR.aviso));
    w.push(etiqueta('u', 12, 62, 456, 20, 'Último: ' + recortar((e.ultimo.cuando ? e.ultimo.cuando + ' · ' : '') + e.ultimo.detalle, 60),
        e.ultimo.ok === null ? COLOR.tenue : e.ultimo.ok ? COLOR.ok : COLOR.peligro));
    w.push(etiqueta('n', 12, 84, 456, 20, 'Se respalda solo cada ' + Math.round(config.RESPALDO_AUTO_MS / 60000)
        + ' min si hay cambios', COLOR.tenue));

    w.push(boton('ip', 12, 112, 224, 34, e.destino ? 'Cambiar IP del PC' : 'Poner IP del PC', COLOR.acento,
        () => ir('respaldoIp')));
    w.push(boton('apagar', 244, 112, 224, 34, 'Apagar respaldo', COLOR.suave, () => {
        respaldo.fijarDestino(null);
        decir('Respaldo apagado', COLOR.aviso);
        repintar();
    }));

    w.push(boton('subir', 12, 148, 224, 38, 'Respaldar ahora', COLOR.ok, () => {
        if (!e.destino) {
            decir('Ponga primero la IP del PC', COLOR.peligro);
            repintar();
            return;
        }
        decir('Enviando…', COLOR.suave);
        repintar();
        respaldo.exportar((r) => {
            decir(r.detalle, r.ok ? COLOR.ok : COLOR.peligro);
            repintar();
        });
    }));

    // Restaurar y dar de alta gente nueva son DOS cosas distintas y por eso son dos
    // botones. Con uno solo, la plantilla de ejemplo del servidor acabó dada de alta
    // como si fueran usuarios de verdad.
    const traer = (origen, clave, aviso) => () => {
        if (!e.destino) {
            decir('Ponga primero la IP del PC', COLOR.peligro);
            repintar();
            return;
        }
        if (confirmar !== clave) {
            confirmar = clave;
            decir(aviso, COLOR.aviso);
            repintar();
            return;
        }
        confirmar = null;
        decir('Leyendo del PC…', COLOR.suave);
        repintar();
        respaldo.importar(origen, (r) => {
            decir(r.detalle, r.ok ? COLOR.ok : COLOR.peligro);
            repintar();
        });
    };

    w.push(boton('restaurar', 244, 148, 224, 38,
        confirmar === 'restaurar' ? '¿Seguro? Toque otra vez' : 'Restaurar último respaldo',
        confirmar === 'restaurar' ? COLOR.peligro : COLOR.acento,
        traer('restaurar', 'restaurar', 'Devuelve los usuarios del último respaldo, con su PIN')));

    w.push(boton('altas', 12, 190, 456, 34,
        confirmar === 'altas' ? '¿Seguro? Toque otra vez' : 'Dar de alta la lista del PC (usuarios.json)',
        confirmar === 'altas' ? COLOR.peligro : COLOR.acento,
        traer('usuarios', 'altas', 'Dará de alta a la gente escrita en usuarios.json')));

    w.push(etiqueta('a', 12, 230, 456, 20, 'El respaldo lleva los PIN: guárdelo como tal', COLOR.aviso));
    w.push(etiqueta('c', 12, 250, 456, 20, 'En el PC: "Respaldo impresora.bat", déjelo abierto', COLOR.tenue));
    w.push(etiqueta('msg', 12, 272, 456, 44, recortar(mensaje, 62), colorMensaje));
    return w;
}

function renderRespaldoIp() {
    ambito('ajip');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 6, 220, 22, 'IP del PC de respaldo', COLOR.texto));
    w.push(boton('cancelar', 238, 4, 110, 32, 'Cancelar', COLOR.suave, () => ir('respaldo')));
    w.push(boton('seguir', 356, 4, 112, 32, 'Guardar', COLOR.ok, () => {
        if (!respaldo.fijarDestino(borrador)) {
            decir('Escriba una IP como 192.168.1.50', COLOR.peligro);
            repintar();
            return;
        }
        ir('respaldo');
        decir('PC de respaldo: ' + borrador, COLOR.ok);
        repintar();
    }));
    w.push(etiqueta('v', 12, 44, 456, 30, borrador || '_', COLOR.acento, 'center'));
    w.push(etiqueta('h', 12, 78, 456, 20, 'Sólo la IP; el puerto es el ' + config.RESPALDO_PUERTO,
        COLOR.tenue, 'center'));
    w.push(etiqueta('msg', 12, 100, 456, 20, recortar(mensaje, 62), colorMensaje, 'center'));
    // El teclado de texto trae dígitos y el punto: sirve para una IP.
    w.push(...tecladoTexto('kb', 156, (t) => {
        if (t === '<') {
            borrador = borrador.slice(0, -1);
        } else if (/^[0-9.]$/.test(t) && borrador.length < 15) {
            borrador += t;
        }
        decir('', COLOR.suave);
        repintar();
    }));
    return w;
}

/* ------------------------------------------------------------------ */
/* Contadores y registro                                                */
/* ------------------------------------------------------------------ */

function renderContadores() {
    ambito('ajc');
    const info = paginar(store.contadores(), pagina, config.FILAS_POR_PAGINA + 1);
    pagina = info.pagina;
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 22, 'Contadores', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => ir('menu')));
    if (info.total === 0) {
        w.push(etiqueta('vacio', 12, 70, 456, 22, 'Todavía no hay trabajos contados', COLOR.suave, 'center'));
    }
    let y = 44;
    for (const r of info.items) {
        const sin = r.quien === store.SIN_SESION;
        w.push(etiqueta('q' + r.quien, 12, y, 150, 20, recortar(sin ? 'Sin sesión' : r.quien, 16),
            sin && (r.impresiones + r.copias) > 0 ? COLOR.peligro : COLOR.texto));
        w.push(etiqueta('c' + r.quien, 166, y, 302, 20,
            r.impresiones + ' imp. ' + r.paginas + ' pág. · ' + r.copias + ' cop. ' + r.paginasCopia + ' pág.', COLOR.suave));
        y += 34;
    }
    w.push(...paginador('pg', 12, 214, info, () => { pagina--; repintar(); }, () => { pagina++; repintar(); }));
    const t = store.totales();
    w.push(etiqueta('tot', 12, 250, 456, 20,
        'Total: ' + t.impresiones + ' impresiones, ' + t.paginas + ' pág. · ' + t.copias + ' copias, ' + t.paginasCopia + ' pág.',
        COLOR.texto));
    w.push(boton('reiniciar', 12, 276, 220, 34, confirmar === 'reiniciar' ? 'Toque otra vez' : 'Poner a cero',
        COLOR.peligro, () => {
            if (confirmar !== 'reiniciar') {
                confirmar = 'reiniciar';
            } else {
                store.reiniciarContadores();
                confirmar = null;
            }
            repintar();
        }));
    return w;
}

function renderRegistro() {
    ambito('ajr');
    const info = paginar(store.registro(), pagina, 9);
    pagina = info.pagina;
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 22, 'Últimos trabajos', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 30, 'Volver', COLOR.acento, () => ir('menu')));
    if (info.total === 0) {
        w.push(etiqueta('vacio', 12, 70, 456, 22, 'Sin registros todavía', COLOR.suave, 'center'));
    }
    info.items.forEach((r, i) => {
        const hora = String(r.hora || '').slice(5, 16);
        const quien = r.quien === store.SIN_SESION ? 'SIN SESIÓN' : r.quien;
        w.push(etiqueta('r' + i, 12, 42 + i * 21, 456, 20,
            recortar(hora + ' ' + quien + ' ' + (r.tipo === 'COPY' ? 'copia' : 'imp.') + ' ' + r.paginas + 'p '
                + (r.estado && r.estado !== 'COMPLETED' ? r.estado : ''), 62),
            r.quien === store.SIN_SESION ? COLOR.peligro : COLOR.texto));
    });
    w.push(...paginador('pg', 12, 240, info, () => { pagina--; repintar(); }, () => { pagina++; repintar(); }));
    return w;
}
