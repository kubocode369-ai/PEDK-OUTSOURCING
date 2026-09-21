/**
 * Panel de administración servido por la PROPIA impresora, como la web de Pantum:
 *
 *     http://<ip>/pedk/app_notify/impresion-pin-BM5220ADW
 *
 * Medido el 21-09-2026: el firmware llama a `pedk.net.http.receiveData` con cada
 * petición cuya ruta empieza por /pedk/app_notify/<nombre de la app> (el `name` del
 * package.json) y devuelve el `Response` que construyamos. Sin el nombre, contesta él
 * mismo "app name is not find!!!" y la app ni se entera.
 *
 * Sesión: el PIN de administrador (el mismo del panel) abre un TOKEN que viaja en la
 * dirección (?s=) y en un campo oculto de cada formulario. No se usan cookies porque
 * no sabemos si el firmware entrega las cabeceras de la petición; y como el token no
 * lo manda el navegador solo, sirve también de protección contra formularios ajenos.
 * La web va por HTTP sin cifrar: en la red de la oficina el PIN viaja en claro.
 */
import { config } from './config.js';
import { guard } from './guard.js';
import * as store from './store.js';

const BASE = '/pedk/app_notify/' + config.WEB_APP;
/** Clave del freno de intentos: compartida con nadie, sólo la web. */
const FRENO = '#web-admin';

let instalada = false;
let motivo = 'sin probar';
let peticiones = 0;
let ultima = '';

/** token -> caduca (ms). En memoria: reiniciar la app cierra todas las sesiones. */
const sesiones = new Map();
let semilla = 0;

function http() {
    return globalThis.pedk && pedk.net && pedk.net.http;
}

function escapar(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Leer la petición                                                     */
/* ------------------------------------------------------------------ */

/** Qué trae la petición, sin suponer su forma: la doc no la describe. */
function describir(req) {
    if (req === null || typeof req !== 'object') {
        return typeof req + ' ' + String(req).slice(0, 80);
    }
    const partes = [];
    for (const k of Object.keys(req)) {
        const v = req[k];
        partes.push(k + '=' + (typeof v === 'object' && v !== null
            ? '{' + Object.keys(v).join(',') + '}' : String(v).slice(0, 60)));
    }
    return partes.join(' ') || '(sin campos)';
}

function decodificar(s) {
    try {
        return decodeURIComponent(String(s).replace(/\+/g, ' '));
    } catch (e) {
        return String(s);
    }
}

/** "a=1&b=x+y" -> {a:'1', b:'x y'} */
function parsearFormulario(texto, destino) {
    const out = destino || {};
    String(texto || '').split('&').forEach((par) => {
        if (!par) return;
        const i = par.indexOf('=');
        const k = decodificar(i < 0 ? par : par.slice(0, i));
        out[k] = i < 0 ? '' : decodificar(par.slice(i + 1));
    });
    return out;
}

/** El cuerpo puede llegar como texto, como RequestBody {data} o ya como objeto. */
function cuerpoDe(req) {
    let b = req.body !== undefined ? req.body : req.data;
    if (b && typeof b === 'object' && b.data !== undefined) {
        b = b.data;
    }
    if (b === undefined || b === null) return {};
    if (typeof b === 'object') {
        const o = {};
        Object.keys(b).forEach((k) => { o[k] = String(b[k]); });
        return o;
    }
    const t = String(b).trim();
    if (t.charAt(0) === '{') {
        try { return cuerpoDe({ body: JSON.parse(t) }); } catch (e) { /* no era JSON */ }
    }
    return parsearFormulario(t);
}

/** {ruta: '/usuarios', metodo: 'POST', datos: {...query y cuerpo}} */
export function leerPeticion(req) {
    const r = req && typeof req === 'object' ? req : {};
    let url = String(r.url || r.path || r.uri || '');
    url = url.replace(/^https?:\/\/[^/]*/, '');
    const q = url.indexOf('?');
    const datos = q < 0 ? {} : parsearFormulario(url.slice(q + 1));
    let ruta = q < 0 ? url : url.slice(0, q);
    const i = ruta.indexOf(config.WEB_APP);
    ruta = i < 0 ? ruta : ruta.slice(i + config.WEB_APP.length);
    ruta = '/' + ruta.replace(/^\/+|\/+$/g, '');
    Object.assign(datos, cuerpoDe(r));
    return { ruta, metodo: String(r.method || 'GET').toUpperCase(), datos };
}

/* ------------------------------------------------------------------ */
/* Sesiones                                                             */
/* ------------------------------------------------------------------ */

function nuevoToken(ahora) {
    semilla++;
    let t = '';
    while (t.length < 24) {
        t += Math.floor(Math.random() * 0x100000000).toString(16);
    }
    t = (((ahora ^ semilla) >>> 0).toString(16) + t).slice(0, 24);
    sesiones.set(t, ahora + config.WEB_SESION_MS);
    return t;
}

/** ¿Token vivo? Si sí, alarga su vida. */
function sesionValida(token, ahora) {
    for (const [t, hasta] of sesiones) {
        if (hasta <= ahora) sesiones.delete(t);
    }
    if (!token || !sesiones.has(token)) return false;
    sesiones.set(token, ahora + config.WEB_SESION_MS);
    return true;
}

/* ------------------------------------------------------------------ */
/* Páginas                                                              */
/* ------------------------------------------------------------------ */

/*
 * TOPE DE TAMAÑO (medido el 21-09-2026): una respuesta de 4390 bytes se anunció y no
 * se envió, y desde ahí el firmware contestó "app response time out!!!" a todo hasta
 * reiniciar. Con 1408 bytes iba bien. Por eso cada byte cuenta: el estilo va en su
 * propia respuesta, todas las rutas son relativas a <base>, la lista de usuarios se
 * pagina según lo que quepa, la ficha de un usuario es UN formulario con un botón por
 * acción, y `atender` nunca deja salir nada por encima de config.WEB_MAX_BYTES.
 */

const ESTILO = 'body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#222}'
    + 'header{background:#1f4e79;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}'
    + 'header h1{font-size:17px;margin:0}header a{color:#fff}'
    + 'main{padding:12px 16px;max-width:760px}'
    + '.caja{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin-bottom:12px}'
    + 'table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #e3e3e3;padding:6px}'
    + 'input{padding:5px;font-size:14px;margin:2px 0}button{padding:5px 10px;font-size:14px;cursor:pointer;margin:2px 0}'
    + '.ok{color:#1b7a2f}.error{color:#b3261e}.aviso{background:#fff4d6}.inactivo{color:#999}';

/** Bytes que ocupa el texto en UTF-8: el tope es de bytes, no de caracteres. */
export function bytesUtf8(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

function documento(titulo, cabecera, cuerpo) {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><base href="' + BASE + '/">'
        + '<title>' + escapar(titulo) + '</title><link rel="stylesheet" href="estilo.css"></head><body>'
        + '<header><h1>' + escapar(titulo) + '</h1>' + (cabecera || '') + '</header><main>' + cuerpo + '</main></body></html>';
}

function mensajeHtml(msg) {
    return msg ? '<p class="' + (msg.ok ? 'ok' : 'error') + '">' + escapar(msg.texto) + '</p>' : '';
}

/** Enlace GET dentro de la sesión. `ruta` sin barra: es relativa a <base>. */
function enlace(token, ruta, extra, texto) {
    return '<a href="' + ruta + '?s=' + token + (extra || '') + '">' + texto + '</a>';
}

/** Formulario POST con el token. Los botones van en `campos`. */
function formulario(token, accion, campos) {
    return '<form method="post" action="' + accion + '"><input type="hidden" name="s" value="' + token + '">'
        + campos + '</form>';
}

function campoPin(placeholder) {
    return '<input type="password" name="pin" placeholder="' + placeholder + '" size="8" inputmode="numeric"> ';
}

function paginaLogin(msg) {
    return documento('Impresión con PIN', '', '<div class="caja"><form method="post" action="entrar">'
        + '<p>PIN de administrador (el mismo del panel):</p>'
        + '<input type="password" name="pin" inputmode="numeric" autofocus> '
        + '<button>Entrar</button></form>' + mensajeHtml(msg) + '</div>');
}

/**
 * Pagina `filas` (HTML de cada fila) según lo que quepa en el tope. `armar(filas, pie)`
 * devuelve la página entera. Los cortes se calculan siempre desde la primera fila: cada
 * página sale igual la pida quien la pida.
 */
function paginarFilas(token, ruta, filas, pagina, armar) {
    const reserva = 200;   // lo que ocupan "« Anterior · Página x de y · Siguiente »"
    const cortes = [0];
    let acumulado = '';
    for (let i = 0; i < filas.length; i++) {
        if (acumulado && bytesUtf8(armar(acumulado + filas[i], '')) + reserva > config.WEB_MAX_BYTES) {
            cortes.push(i);
            acumulado = '';
        }
        acumulado += filas[i];
    }
    const total = cortes.length;
    const n = Math.max(0, Math.min(total - 1, Math.floor(Number(pagina)) || 0));
    const hasta = n + 1 < total ? cortes[n + 1] : filas.length;
    let pie = '';
    if (total > 1) {
        pie = '<p>' + (n > 0 ? enlace(token, ruta, '&p=' + (n - 1), '« Anterior') + ' · ' : '')
            + 'Página ' + (n + 1) + ' de ' + total
            + (n + 1 < total ? ' · ' + enlace(token, ruta, '&p=' + (n + 1), 'Siguiente »') : '') + '</p>';
    }
    return armar(filas.slice(cortes[n], hasta).join(''), pie);
}

/** Lista compacta de usuarios. */
function paginaUsuarios(token, msg, pagina) {
    const lista = store.usuarios();
    const cab = '<span>' + enlace(token, 'contadores', '', 'Contadores') + ' · '
        + enlace(token, 'nuevo', '', 'Nuevo usuario') + ' · ' + enlace(token, 'salir', '', 'Salir') + '</span>';
    const aviso = store.pinAdminDeFabrica()
        ? '<p class="caja aviso">El PIN de administrador es el de fábrica: cámbielo en el panel.</p>' : '';
    const filas = lista.map((u) => {
        const c = store.contadorDe(u.nombre);
        return '<tr' + (u.activo === false ? ' class="inactivo"' : '') + '><td>'
            + enlace(token, 'usuario', '&n=' + encodeURIComponent(u.nombre), '<b>' + escapar(u.nombre) + '</b>')
            + '</td><td>' + (u.activo === false ? 'desactivado' : 'activo') + '</td><td>'
            + (c.paginas + c.paginasCopia) + ' pág.</td></tr>';
    });
    return paginarFilas(token, 'usuarios', filas, pagina, (f, pie) => documento('Usuarios (' + lista.length + ')', cab,
        aviso + mensajeHtml(msg) + '<div class="caja">' + (lista.length ? '<table>' + f + '</table>' : 'No hay usuarios.')
        + pie + '</div>'));
}

/** Cómo se llama en pantalla y en el CSV a quien no se identificó. */
function persona(quien) {
    return quien === store.SIN_SESION ? 'Sin identificar' : quien;
}

function paginaContadores(token, msg, pagina) {
    const lista = store.contadores();
    const t = store.totales();
    const cab = '<span>' + enlace(token, 'usuarios', '', 'Usuarios') + ' · ' + enlace(token, 'salir', '', 'Salir') + '</span>';
    const filas = lista.map((c) => '<tr><td><b>' + escapar(persona(c.quien)) + '</b></td><td>' + c.impresiones
        + '</td><td>' + c.paginas + '</td><td>' + c.copias + '</td><td>' + c.paginasCopia + '</td><td>'
        + (c.paginas + c.paginasCopia) + '</td></tr>');
    const acciones = '<p><button data-s="' + token + '" onclick="bajarCsv(this)">Descargar CSV (Excel)</button></p>'
        + formulario(token, 'cero', '<button onclick="return confirm(\'¿Poner TODOS los contadores a cero? '
            + 'Descargue antes el CSV.\')">Poner a cero</button>');
    return paginarFilas(token, 'contadores', filas, pagina, (f, pie) => documento('Contadores', cab, mensajeHtml(msg)
        + '<div class="caja"><p>Total: <b>' + (t.paginas + t.paginasCopia) + '</b> pág. (' + t.paginas + ' impresas, '
        + t.paginasCopia + ' copiadas)</p>'
        + (lista.length
            ? '<table><tr><td>Persona</td><td>Impr.</td><td>Pág.</td><td>Copias</td><td>Pág. copia</td><td>Total</td></tr>'
                + f + '</table>'
            : 'Aún no hay nada contado.')
        + pie + '</div><div class="caja">' + acciones + '</div><script src="csv.js"></script>'));
}

/*
 * CSV por partes: un CSV con mucha gente no cabe en una respuesta. El navegador pide
 * /csv?desde=0, luego desde=<siguiente>... y lo junta en un solo fichero. Mismo formato
 * que respaldos/contadores.csv del servidor de respaldo: ';' y BOM para Excel en español.
 * La primera línea de cada parte es "SIGUIENTE;<índice o -1>" y el navegador la quita.
 */
export function parteCsv(desde) {
    const lista = store.contadores();
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    let texto = i0 === 0 ? 'Persona;Impresiones;Paginas impresas;Copias;Paginas copiadas;TOTAL paginas\n' : '';
    let i = i0;
    const margen = 120;   // la línea SIGUIENTE y la de TOTAL
    for (; i < lista.length; i++) {
        const c = lista[i];
        const linea = persona(c.quien).replace(/[;\r\n]/g, ' ') + ';' + c.impresiones + ';' + c.paginas + ';'
            + c.copias + ';' + c.paginasCopia + ';' + (c.paginas + c.paginasCopia) + '\n';
        if (i > i0 && bytesUtf8(texto + linea) + margen > config.WEB_MAX_BYTES) {
            break;
        }
        texto += linea;
    }
    if (i >= lista.length) {
        const t = store.totales();
        if (lista.length) {
            texto += 'TOTAL;' + t.impresiones + ';' + t.paginas + ';' + t.copias + ';' + t.paginasCopia + ';'
                + (t.paginas + t.paginasCopia) + '\n';
        }
        return 'SIGUIENTE;-1\n' + texto;
    }
    return 'SIGUIENTE;' + i + '\n' + texto;
}

/* El script que junta las partes. La fecha la pone el navegador: el reloj de la
   impresora va horas adelantado respecto al de la app (medido). */
const CSV_JS = 'function bajarCsv(b){var s=b.getAttribute("data-s"),t="",n=0;b.disabled=true;'
    + 'function fin(e){b.disabled=false;if(e){alert("No se pudo descargar: "+e);return}'
    + 'var d=new Date(),f=d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2);'
    + 'var h=f+" "+("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);'
    + 'var a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\\ufeffDescargado;"+h+"\\n\\n"+t],{type:"text/csv;charset=utf-8"}));'
    + 'a.download="contadores-"+f+".csv";document.body.appendChild(a);a.click();a.remove()}'
    + 'function pedir(desde){if(++n>200)return fin("demasiadas partes");'
    + 'fetch("csv?s="+s+"&desde="+desde).then(function(r){return r.text()}).then(function(x){'
    + 'var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m)return fin("la sesión caducó, vuelva a entrar");'
    + 't+=x.slice(m[0].length);var sig=+m[1];if(sig<0)fin();else pedir(sig)}).catch(function(e){fin(e)})}'
    + 'pedir(0)}';

function paginaNuevo(token, msg) {
    return documento('Nuevo usuario', enlace(token, 'usuarios', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja">' + formulario(token, 'alta',
            '<input name="nombre" placeholder="usuario" maxlength="' + config.USUARIO_MAX + '" autocomplete="off"> '
            + campoPin('PIN') + '<button>Dar de alta</button>')
        + '<p><small>Usuario: minúsculas, números y . _ - (el Nombre del driver). PIN: '
        + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos (la Contraseña del driver).</small></p></div>');
}

function paginaUsuario(token, nombre, msg) {
    const u = store.usuarios().filter((x) => x.nombre === nombre)[0];
    if (!u) {
        return paginaUsuarios(token, msg || { ok: false, texto: 'No existe el usuario ' + nombre + '.' });
    }
    const c = store.contadorDe(u.nombre);
    const inactivo = u.activo === false;
    return documento('Usuario ' + u.nombre, enlace(token, 'usuarios', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja"><p>' + (inactivo ? 'Desactivado' : 'Activo') + ' · ' + c.impresiones
        + ' impresiones, ' + c.paginas + ' pág. · ' + c.copias + ' copias, ' + c.paginasCopia + ' pág.</p>'
        + formulario(token, 'cambiar', '<input type="hidden" name="nombre" value="' + escapar(u.nombre) + '">'
            + campoPin('PIN nuevo') + '<button name="a" value="pin">Cambiar PIN</button><p>'
            + '<button name="a" value="' + (inactivo ? 'activar">Activar' : 'desactivar">Desactivar') + '</button> '
            + '<button name="a" value="borrar" onclick="return confirm(\'¿Borrar?\')">Borrar</button></p>')
        + '</div>');
}

/* ------------------------------------------------------------------ */
/* Rutas                                                                */
/* ------------------------------------------------------------------ */

/** Atiende una petición ya leída. Devuelve {codigo, tipo, cuerpo}. Exportada para las pruebas. */
export function atenderRuta(p, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    const d = p.datos;
    const html = (cuerpo) => ({ codigo: 200, tipo: 'text/html; charset=utf-8', cuerpo });

    if (p.ruta === '/estilo.css') {
        return { codigo: 200, tipo: 'text/css; charset=utf-8', cuerpo: ESTILO };
    }
    if (p.ruta === '/csv.js') {
        return { codigo: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: CSV_JS };
    }
    if (p.ruta === '/eco') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: 'ruta=' + p.ruta + ' metodo=' + p.metodo
            + ' campos=' + Object.keys(d).join(',').slice(0, 200) + '\n' + ultima };
    }
    // Para MEDIR el tope: /tam?n=2000 devuelve 2000 bytes. Pasarse cuelga la web hasta reiniciar.
    if (p.ruta === '/tam') {
        const n = Math.max(0, Math.min(65536, Math.floor(Number(d.n) || 0)));
        return { codigo: 200, tipo: 'text/plain', cuerpo: new Array(n + 1).join('x'), sinTope: true };
    }

    if (p.ruta === '/entrar' && p.metodo === 'POST') {
        const espera = store.esperaPorIntentos(FRENO, t);
        if (espera > 0) {
            return html(paginaLogin({ ok: false, texto: 'Demasiados intentos. Espere ' + espera + ' min.' }));
        }
        if (!store.esPinAdmin(d.pin)) {
            store.anotarFallo(FRENO, t);
            console.log('[web] PIN de administrador incorrecto');
            return html(paginaLogin({ ok: false, texto: 'PIN incorrecto.' }));
        }
        store.olvidarFallos(FRENO);
        console.log('[web] entra el administrador');
        return html(paginaUsuarios(nuevoToken(t)));
    }

    const token = d.s;
    if (!sesionValida(token, t)) {
        return html(paginaLogin(token ? { ok: false, texto: 'La sesión caducó. Vuelva a entrar.' } : null));
    }

    const nombre = store.normalizarUsuario(d.nombre || d.n);
    const anotar = (msg) => {
        console.log('[web] ' + p.ruta + ' ' + (d.a || '') + ' ' + nombre + ': ' + msg.texto);
        return msg;
    };
    // Salir sólo cierra la sesión: puede ir por un enlace.
    if (p.ruta === '/salir') {
        sesiones.delete(token);
        return html(paginaLogin({ ok: true, texto: 'Sesión cerrada.' }));
    }
    if (p.ruta === '/contadores') {
        return html(paginaContadores(token, null, d.p));
    }
    if (p.ruta === '/csv') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteCsv(d.desde) };
    }
    if (p.ruta === '/nuevo') {
        return html(paginaNuevo(token));
    }
    if (p.ruta === '/usuario') {
        return html(paginaUsuario(token, nombre));
    }
    // Todo lo que cambia algo va por POST: un enlace o una recarga no deben dar de alta ni borrar.
    const cambia = p.metodo === 'POST';
    if (p.ruta === '/alta' && cambia) {
        const r = store.agregarUsuario(d.nombre, d.pin);
        return r.ok
            ? html(paginaUsuarios(token, anotar({ ok: true, texto: 'Usuario ' + nombre + ' dado de alta.' })))
            : html(paginaNuevo(token, anotar({ ok: false, texto: r.error })));
    }
    if (p.ruta === '/cambiar' && cambia) {
        const existe = store.usuarios().some((u) => u.nombre === nombre);
        if (!existe) {
            return html(paginaUsuarios(token, anotar({ ok: false, texto: 'No existe el usuario ' + nombre + '.' })));
        }
        if (d.a === 'borrar') {
            store.quitarUsuario(nombre);
            return html(paginaUsuarios(token, anotar({ ok: true, texto: nombre + ' borrado. Sus contadores se conservan.' })));
        }
        let msg;
        if (d.a === 'pin') {
            msg = store.pinValido(d.pin) && store.cambiarPinUsuario(nombre, d.pin)
                ? { ok: true, texto: 'PIN cambiado. Cámbielo también en el driver de su PC.' }
                : { ok: false, texto: 'PIN de ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos.' };
        } else if (d.a === 'activar' || d.a === 'desactivar') {
            store.activarUsuario(nombre, d.a === 'activar');
            msg = { ok: true, texto: nombre + (d.a === 'activar' ? ' activado.' : ' desactivado.') };
        } else {
            msg = { ok: false, texto: 'Acción desconocida.' };
        }
        return html(paginaUsuario(token, nombre, anotar(msg)));
    }
    if (p.ruta === '/cero' && cambia) {
        const t = store.totales();
        store.reiniciarContadores();
        return html(paginaContadores(token, anotar({ ok: true, texto: 'Contadores a cero (había '
            + (t.paginas + t.paginasCopia) + ' páginas).' })));
    }
    return html(paginaUsuarios(token, null, d.p));
}

const DEMASIADO = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
    + '<p>La respuesta no cabe en lo que la impresora puede enviar. Vuelva atrás.</p></body></html>';

function atender(req) {
    peticiones++;
    ultima = describir(req);
    console.log('[web] peticion ' + peticiones + ': ' + ultima);
    let r;
    try {
        r = atenderRuta(leerPeticion(req));
    } catch (e) {
        console.log('[web] error: ' + String((e && e.message) || e).slice(0, 120));
        r = { codigo: 500, tipo: 'text/html; charset=utf-8', cuerpo: '<p>Error interno. Vuelva a intentarlo.</p>' };
    }
    // Pasarse del tope cuelga la web entera hasta reiniciar: nunca se deja salir.
    const tam = bytesUtf8(r.cuerpo);
    if (!r.sinTope && tam > config.WEB_MAX_BYTES) {
        console.log('[web] respuesta de ' + tam + ' bytes excede el tope ' + config.WEB_MAX_BYTES + ': no se envía');
        r = { codigo: 500, tipo: 'text/html; charset=utf-8', cuerpo: DEMASIADO };
    }
    const h = http();
    return new h.Response(r.codigo, new h.Headers('Content-Type', r.tipo), r.cuerpo);
}

/** Se engancha al servidor web del equipo. Nunca lanza: si no hay API, lo dice. */
export function instalar() {
    const h = http();
    instalada = false;
    if (!h) {
        motivo = 'no hay pedk.net.http';
    } else if (typeof h.Response !== 'function' || typeof h.Headers !== 'function') {
        motivo = 'faltan Response/Headers';
    } else {
        const antes = h.receiveData;
        try {
            h.receiveData = guard('web', atender);
            instalada = h.receiveData !== antes;
            motivo = instalada ? 'activa en ' + BASE : 'la asignación no quedó (solo lectura)';
        } catch (e) {
            motivo = 'error al asignar: ' + ((e && e.message) || e);
        }
    }
    console.log('[web] ' + motivo);
    return { ok: instalada, motivo };
}

export function informe() {
    return ['Web: ' + motivo + ' · peticiones ' + peticiones, ultima ? 'Ultima: ' + ultima : 'Ultima: ninguna'];
}

/** Para las pruebas: cerrar todas las sesiones. */
export function _reiniciar() {
    sesiones.clear();
}
