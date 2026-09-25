/**
 * Panel de administración servido por la PROPIA impresora, como la web de Pantum:
 *
 *     http://<ip>/pedk/app_notify/vizo/   (LA BARRA FINAL ES OBLIGATORIA)
 *
 * Medido el 25-09-2026 al renombrar la app a "vizo": SIN la barra final el firmware
 * contesta él mismo "app name is not find!!!" aunque la app esté corriendo y haya
 * registrado su web (en el log: `start app[vizo]` y `[web] activa en …`). Con la
 * barra funciona todo. Con el nombre anterior ("impresion") no hacía falta, así que
 * parece depender del nombre; no se ha aislado por qué.
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
import * as acciones from './acciones.js';
import * as cerradura from './cerradura.js';
import { inflar } from './inflate.js';
import { PLANTILLA_XLSX_B64 } from './plantilla.js';

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

/**
 * Un navegador manda los formularios en UTF-8 (la página lo declara). Pero algo que
 * mande Latin-1 ("é" = %E9) hace lanzar a decodeURIComponent, y antes se guardaba el
 * texto crudo ("Jos%E9+P%E9rez", medido con curl): ahora cada %XX se lee como Latin-1.
 */
function decodificar(s) {
    const t = String(s).replace(/\+/g, ' ');
    try {
        return decodeURIComponent(t);
    } catch (e) {
        return t.replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
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
    // 16 caracteres hex = 64 bits: imposible de adivinar en los 15 min que dura, y cada
    // byte cuenta porque el token va en todos los enlaces (ver el tope de respuesta).
    while (t.length < 16) {
        t += Math.floor(Math.random() * 0x100000000).toString(16);
    }
    t = (((ahora ^ semilla) >>> 0).toString(16).slice(-4) + t).slice(0, 16);
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

/*
 * DISEÑO. Inspirado en la web de administración de Pantum (rojo corporativo, barra de
 * pestañas con la activa en rojo, paneles con cabecera de color), pero SIN su logotipo:
 * la página es de esta app, no de Pantum. Responsive: en el móvil las pestañas se
 * deslizan, las tablas se desplazan de lado y los campos ocupan todo el ancho.
 *
 * Todo cabe en el tope de ~1,8 KB por respuesta: el estilo va en su propio fichero, las
 * clases son cortas y no hay imágenes ni fuentes descargadas.
 *   .c panel (h2 = cabecera roja)   .b enlace con forma de botón   (botón gris por defecto)
 *   .p botón principal (rojo)   .x botón peligroso   .w aviso amarillo   p.ok / p.error mensajes   .t tabla deslizable
 *   .g / .r etiqueta verde / gris   .v "‹ Volver"   .k pie pequeño
 */
// En dos ficheros (juntos pasan del tope); el primero trae al segundo con @import (ver la
// ruta /estilo.css, que le añade la versión).
/*
 * UNA sola hoja de estilos, y ajustada para caber en una respuesta (~1,9 KB). Estaba en
 * dos ficheros con @import y eso encadenaba una petición más: en la primera carga, la
 * segunda hoja esperaba en la cola detrás del script de la lista, pasaba de los ~5 s que
 * aguanta el firmware y se perdía. El administrador veía la página sin estilo y sin
 * opciones hasta recargar dos o tres veces (visto el 23-09-2026).
 */
/**
 * EL LOGO, en SVG. Es texto, así que la impresora lo sirve como cualquier otra página
 * (un PNG no podría: las respuestas son cadenas y el binario no sobreviviría). Se pide
 * UNA vez —con ?v=huella y caché de un año— y en cada página sólo cuesta la etiqueta
 * <img>. Antes iba dibujado dentro de la página de acceso, pero así se ve en TODAS sin
 * gastar bytes en cada una.
 *
 * La V son los trazos del logo. La palabra va como texto en Arial Black, que es lo más
 * parecido que hay en cualquier PC, con el punto rojo sobre la i dibujado aparte.
 */
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 88">'
    + '<path fill="#c1122f" d="M3 4h24l36 78q-16 5-22-6L3 4z"/>'
    + '<path fill="#3a4048" d="M97 4H73L52 46l11 24z"/>'
    + '<text x="108" y="74" font-family="Arial Black,Arial" font-size="80" letter-spacing="-3" fill="#3a4048">Vizo</text>'
    + '<rect x="198" y="8" width="17" height="15" fill="#c1122f"/></svg>';

const ESTILO = '*{box-sizing:border-box}'
    + 'body{margin:0;font:15px/1.4 arial,tahoma,sans-serif;background:#f4f4f4;color:#333}'
    + 'header{background:#fff;padding:9px 16px;text-align:center;border-bottom:3px solid #b03}'
    + 'header img{height:34px}'
    + 'nav{display:flex;overflow-x:auto;background:#eee;border-bottom:1px solid #bbb}'
    + 'nav a{padding:11px 16px;color:#333;font-weight:600;text-decoration:none;white-space:nowrap}'
    + 'nav a.on{background:#b03;color:#fff}nav a:last-child{margin-left:auto}'
    + 'main{max-width:960px;margin:auto;padding:16px}h1{font-size:21px;margin:4px 0 14px}'
    + '.t{overflow-x:auto;max-width:100%}'
    + '.c{background:#fff;border:3px solid #ccc;margin-bottom:16px;padding:0 16px 14px}'
    + '.c h2{margin:0 -16px 12px;padding:7px 16px;background:#b03;color:#fff}'
    + 'button,.b{display:inline-block;background:#fff;color:#333;border:1px solid #aaa;'
    + 'padding:8px 14px;font:inherit;font-weight:600;text-decoration:none;margin:3px 4px 3px 0}'
    + '.p{background:#b03;color:#fff;border-color:#b03}.x{color:#b03;border-color:#b03}'
    + 'label{display:block;font-weight:600;margin:10px 0 4px}'
    + 'input,select{font:inherit;padding:8px 10px;border:1px solid #bbb;max-width:100%}'
    + 'table{border-collapse:collapse;width:100%}'
    + 'th,td{padding:9px 10px;border-bottom:1px solid #eee;text-align:left}'
    + 'th{background:#f2f2f2;font-size:13px}'
    + 'tr:nth-child(2n) td{background:#fafafa}.n{text-align:right}'
    + '.inactivo{color:#999}p.ok,p.error,.w{padding:10px;border-left:4px solid}'
    + 'p.ok{background:#efe;border-color:#171}p.error{background:#fee;border-color:#b22}'
    + '.w{background:#ffe;border-color:#eb0}.ok{color:#171}.error{color:#b22}'
    + '.g{color:#171}.r,.k{color:#777}.k{font-size:13px}'
    // Móvil: la lista de usuarios (#t) pasa a tarjetas; las demás tablas se deslizan.
    + '@media(max-width:600px){main{padding:10px}.c{padding:0 10px}input{width:100%}'
    + '#t tr:first-child{display:none}#t tr{display:block;padding:8px 0;border-bottom:1px solid #eee}'
    + '#t td{display:inline-block;border:0;padding:2px 8px 2px 0;background:none}'
    + '#t td:last-child{display:flex;gap:4px;margin-top:4px}}';

/*
 * VELOCIDAD (medido el 22-09-2026): cada petición a la app tarda ~1,15 s pase lo que pase
 * (hasta /eco, que no hace nada; la web de Pantum, servida por el firmware, 0,03 s), y
 * la impresora las atiende DE UNA EN UNA. Una página tarda, por tanto, lo que sumen sus
 * peticiones. Para que sean las menos posibles:
 *  - estilos y scripts se piden con su versión (?v=<huella de su contenido>) y con
 *    Cache-Control de un año: el navegador los guarda y no los vuelve a pedir; al
 *    actualizar la app cambia la huella y los pide de nuevo.
 *  - los datos de las listas van DENTRO de la página si caben (data-d), sin otra petición.
 */
let version = null;

/** Huella de todos los ficheros estáticos: cambia cuando cambia cualquiera. */
function versionEstaticos() {
    if (!version) {
        version = store.huella('#estaticos', LOGO + ESTILO + LISTA_JS + CONTADORES_JS + CSV_JS + COPIA_BAJAR_JS
            + COPIA_SUBIR_JS + SUBIR_JS + TABLA_JS + IMPORTAR_JS).slice(0, 8);
    }
    return version;
}

/** Dirección de un fichero estático, con su versión. */
function estatico(ruta) {
    return ruta + '?v=' + versionEstaticos();
}

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

const PESTANAS = [['usuarios', 'Usuarios'], ['contadores', 'Contadores'], ['ajustes', 'Ajustes'], ['salir', 'Salir']];

/**
 * Página completa. `token` null = sin sesión (login): sin pestañas. `activa`: qué pestaña
 * va en rojo. `volver`: [ruta, texto] para el "‹ Volver" de las subpáginas.
 */
function documento(titulo, token, activa, cuerpo, volver) {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><base href="' + BASE + '/"><link rel="icon" href="data:,">'
        + '<title>' + escapar(titulo) + '</title><link rel="stylesheet" href="' + estatico('estilo.css') + '"></head><body>'
        + '<header><img src="' + estatico('logo.svg') + '"></header>'
        + (token ? '<nav>' + PESTANAS.map((p) => '<a href="' + p[0] + '?s=' + token + '"'
            + (p[0] === activa ? ' class="on"' : '') + '>' + p[1] + '</a>').join('') + '</nav>' : '')
        + '<main>' + (volver ? '<a class="v" href="' + volver[0] + '?s=' + token + '">‹ ' + volver[1] + '</a>' : '')
        // Sin sesión (la pantalla de acceso) todo va centrado: el título suelto a la
        // izquierda con la caja en el medio queda descolgado.
        + '<h1' + (token ? '>' : ' style="text-align:center">') + escapar(titulo) + '</h1>'
        + cuerpo + '</main></body></html>';
}

/** Un panel con cabecera roja. */
function panel(titulo, cuerpo) {
    return '<div class="c"><h2>' + titulo + '</h2>' + cuerpo + '</div>';
}

function mensajeHtml(msg) {
    return msg ? '<p class="' + (msg.ok ? 'ok' : 'error') + '">' + escapar(msg.texto) + '</p>' : '';
}

/** Enlace GET dentro de la sesión. `ruta` sin barra: es relativa a <base>. `clase`: 'b', 'b s'... */
function enlace(token, ruta, extra, texto, clase) {
    return '<a ' + (clase ? 'class="' + clase + '" ' : '') + 'href="' + ruta + '?s=' + token + (extra || '') + '">' + texto + '</a>';
}

/** Un solo aviso para todos los "Borrar" de la lista: uno por fila no cabría. */
const BORRAR_CONFIRMA = ' onsubmit="var v=event.submitter.value;return v[0]!=\'b\'||confirm(\'¿Borrar a \'+v.slice(2)+\'?\')"';

/** Formulario POST con el token. Los botones van en `campos`. */
function formulario(token, accion, campos, extra) {
    return '<form method="post" action="' + accion + '"' + (extra || '') + '><input type="hidden" name="s" value="' + token + '">'
        + campos + '</form>';
}

/** Campo con su etiqueta encima. */
function campo(etiqueta, input) {
    return '<label>' + etiqueta + '</label>' + input;
}

function campoPin(nombre) {
    return '<input type="password" name="' + (nombre || 'pin') + '" size="10" inputmode="numeric" autocomplete="off">';
}

function paginaLogin(msg) {
    return documento('Administración', null, null, '<div style="max-width:420px;margin:0 auto">'
        // El logo ya está en la cabecera: repetirlo aquí sobraba.
        + mensajeHtml(msg)
        + panel('Entrar', '<form method="post" action="entrar">'
        + campo('PIN de administrador', '<input type="password" name="pin" inputmode="numeric" autofocus>')
        + '<p><button class="p">Entrar</button></p><p class="k">Es el mismo PIN que en Ajustes del panel de la impresora.</p></form>') + '</div>');
}

/*
 * LISTA DE USUARIOS pintada por el navegador. Con el tope de ~2 KB por respuesta, una
 * tabla con botones hecha en la impresora sólo dejaba 3 personas por página. Ahora la
 * impresora manda la página casi vacía y los datos en líneas cortas ("nombre, activo,
 * nombre completo", ~25 bytes por persona, por partes si no caben), y el script dibuja
 * a TODOS en una sola página. Los botones siguen siendo un formulario normal (POST a
 * /lista, x="d ana"), así que la acción la decide y la valida la impresora.
 */
function paginaUsuarios(token, msg) {
    const n = store.usuarios().length;
    const aviso = (store.pinAdminDeFabrica()
        ? '<p class="w">PIN de administrador de fábrica: cámbielo en Ajustes.</p>' : '')
        + (n >= config.USUARIOS_AVISO ? '<p class="w">' + avisoCapacidad(n) + '</p>' : '');
    const armar = (datos) => documento('Usuarios (' + n + ')', token, 'usuarios', aviso + mensajeHtml(msg)
        + '<p>' + enlace(token, 'nuevo', '', '+ Nuevo usuario', 'b p') + enlace(token, 'importar', '', 'Importar Excel', 'b') + '</p>'
        + '<div class="c t">' + formulario(token, 'lista', '<table id="t" data-s="' + token + '"' + conDatos(datos)
            + '></table>', BORRAR_CONFIRMA)
        + '</div>' + scripts(['lista.js']));
    return cabeOno(armar, parteUsuarios(0));
}

/** Atributo con los datos de una lista, para que no haga falta pedirlos aparte. */
function conDatos(datos) {
    return datos === null ? '' : ' data-d="' + escapar(datos) + '"';
}

/** La página con sus datos dentro si caben en el tope; si no, sin ellos (el script los pide). */
function cabeOno(armar, datos) {
    const con = armar(datos);
    return bytesUtf8(con) <= config.WEB_MAX_BYTES ? con : armar(null);
}

/** Lo que se le dice al administrador cuando hay muchos usuarios (ver config.USUARIOS_*). */
function avisoCapacidad(n) {
    return n >= config.USUARIOS_MAX
        ? 'Máximo de ' + config.USUARIOS_MAX + ' usuarios alcanzado: borre alguno para crear otro.'
        : n + ' usuarios: con más de ' + config.USUARIOS_AVISO + ' la impresora tarda más en guardar '
            + 'cada trabajo (máximo ' + config.USUARIOS_MAX + ').';
}

/** Datos de la lista, por partes: "SIGUIENTE;<n o -1>" y una línea por persona. */
export function parteUsuarios(desde) {
    const lista = store.usuarios();
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    let texto = '';
    let i = i0;
    for (; i < lista.length; i++) {
        const u = lista[i];
        const linea = u.nombre + '\t' + (u.activo === false ? '0' : '1') + '\t'
            + String(u.nombreCompleto || '').replace(/[\t\r\n]/g, ' ') + '\n';
        if (i > i0 && bytesUtf8(texto + linea) + 40 > config.WEB_MAX_BYTES) {
            break;
        }
        texto += linea;
    }
    return 'SIGUIENTE;' + (i >= lista.length ? -1 : i) + '\n' + texto;
}

/* Todo con textContent: nada de lo que llega se interpreta como HTML. */
const LISTA_JS = '(function(){var T=document.getElementById("t"),s=T.getAttribute("data-s"),L=[];'
    + 'function e(t,x,c){var n=document.createElement(t);if(x)n.textContent=x;if(c)n.className=c;return n}'
    + 'function b(v,x,c){var n=e("button",x,c);n.name="x";n.value=v;return n}'
    + 'function cab(t){var r=e("tr");t.forEach(function(x){r.appendChild(e("th",x))});T.appendChild(r)}'
    + 'function pinta(){cab(["Usuario","Estado",""]);if(!L.length)return T.appendChild(e("tr")).appendChild(e("td","No hay usuarios."));'
    + 'L.forEach(function(l){var f=l.split("\\t"),a=f[1]=="1",r=e("tr",0,a?"":"inactivo"),d=e("td");'
    + 'd.appendChild(e("b",f[0]));if(f[2]){d.appendChild(e("br"));d.appendChild(e("small",f[2]))}r.appendChild(d);'
    + 'd=e("td");d.appendChild(e("span",a?"activo":"desactivado",a?"g":"r"));r.appendChild(d);'
    + 'd=e("td");d.appendChild(b("e "+f[0],"Editar"));'
    + 'd.appendChild(b((a?"d ":"a ")+f[0],a?"Desactivar":"Activar"));d.appendChild(b("b "+f[0],"Borrar","x"));'
    + 'r.appendChild(d);T.appendChild(r)})}'
    + 'function q(x){var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m){T.textContent="La sesión caducó, vuelva a entrar.";return}'
    + 'x.slice(m[0].length).split("\\n").forEach(function(l){if(l)L.push(l)});if(+m[1]>=0)p(+m[1]);else pinta()}'
    + 'function p(n){fetch("usuarios.txt?s="+s+"&desde="+n).then(function(r){return r.text()}).then(q)}'
    // Los datos vienen en la página (data-d) si cabían: una petición menos.
    + 'var D=T.getAttribute("data-d");D!=null?q(D):p(0)})()';

/** Cómo se llama en pantalla y en el CSV a quien no se identificó. */
function persona(quien) {
    return quien === store.SIN_SESION ? 'Sin identificar' : quien;
}

function paginaContadores(token, msg) {
    const t = store.totales();
    // La tabla la pinta el navegador con los datos del CSV (contadores.js): así salen todos
    // en una página, como en Usuarios. En la impresora sólo cabían unas pocas filas.
    return cabeOno((datos) => documento('Contadores', token, 'contadores', mensajeHtml(msg)
        + '<p>Total: <b>' + (t.paginas + t.paginasCopia) + '</b> páginas de papel (' + t.paginas + ' impresas, '
        + t.paginasCopia + ' copiadas) · ' + t.paginasEscaneo + ' escaneadas</p><div style="margin-bottom:10px">' + botonJs(token, 'csv.js', 'bajarCsv', 'p', 'Descargar CSV (Excel)')
        + formulario(token, 'cero', '<button class="x" onclick="return confirm(\'¿Poner TODOS los contadores a cero? '
            + 'Descargue antes el CSV.\')">Poner a cero</button>', ' style="display:inline"') + '</div>'
        + '<div class="c t"><table id="c" data-s="' + token + '"' + conDatos(datos) + '></table></div>'
        + CARGA_JS + scripts(['contadores.js'])), parteCsv(0));
}

/*
 * contadores.js: pide el CSV por partes (el mismo que se descarga) y pinta la tabla.
 * Columnas del CSV: usuario;nombre;estado;impr;pág;copias;pág copia;escan;pág escan;total. Quien
 * no imprimió nada, en gris. Todo con textContent: nada se interpreta como HTML.
 */
const CONTADORES_JS = '(function(){var T=document.getElementById("c"),s=T.getAttribute("data-s"),L=[];'
    + 'function e(t,x,c){var n=document.createElement(t);if(x!=null)n.textContent=x;if(c)n.className=c;return n}'
    + 'function cab(){var r=e("tr");["Persona","Impr.","Pág.","Copias","Pág. copia","Escan.","Pág. escan.","Papel"].forEach(function(x,i){'
    + 'r.appendChild(e("th",x,i?"n":""))});T.appendChild(r)}'
    + 'function pinta(){cab();if(!L.length)return T.appendChild(e("tr")).appendChild(e("td","No hay usuarios ni nada contado."));'
    + 'L.forEach(function(f){var r=e("tr",null,+f[9]||+f[8]?"":"inactivo"),d=e("td"),x=f[2]=="borrado"?"usuario borrado":f[1]+(f[2]=="desactivado"?" (desactivado)":"");'
    + 'd.appendChild(e("b",f[0]));if(x){d.appendChild(e("br"));d.appendChild(e("small",x))}r.appendChild(d);'
    + '[3,4,5,6,7,8].forEach(function(i){r.appendChild(e("td",f[i],"n"))});d=e("td",null,"n");d.appendChild(e("b",f[9]));r.appendChild(d);T.appendChild(r)})}'
    + 'function q(x){var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m){T.textContent="La sesión caducó, vuelva a entrar.";return}'
    + 'x.slice(m[0].length).split("\\n").forEach(function(l){var f=l.split(";");if(f.length>9&&f[0]!="Usuario"&&f[0]!="TOTAL")L.push(f)});'
    + 'if(+m[1]>=0)p(+m[1]);else pinta()}'
    + 'function p(n){fetch("csv?s="+s+"&desde="+n).then(function(r){return r.text()}).then(q)}'
    + 'var D=T.getAttribute("data-d");D!=null?q(D):p(0)})()';

/*
 * CSV por partes: un CSV con mucha gente no cabe en una respuesta. El navegador pide
 * /csv?desde=0, luego desde=<siguiente>... y lo junta en un solo fichero, con el formato
 * que abre bien Excel en español: ';' y BOM (sin BOM se comen los acentos).
 * La primera línea de cada parte es "SIGUIENTE;<índice o -1>" y el navegador la quita.
 */
export function parteCsv(desde) {
    const lista = store.contadoresDeTodos();
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    let texto = i0 === 0
        ? 'Usuario;Nombre completo;Estado;Impresiones;Paginas impresas;Copias;Paginas copiadas;'
            + 'Escaneos;Paginas escaneadas;TOTAL paginas de papel\n' : '';
    let i = i0;
    const margen = 120;   // la línea SIGUIENTE y la de TOTAL
    for (; i < lista.length; i++) {
        const c = lista[i];
        const estado = c.quien === store.SIN_SESION ? '' : !c.existe ? 'borrado' : c.activo ? 'activo' : 'desactivado';
        const linea = [persona(c.quien), c.nombreCompleto, estado]
            .map((x) => String(x).replace(/[;\r\n"]/g, ' ')).join(';')
            + ';' + c.impresiones + ';' + c.paginas + ';' + c.copias + ';' + c.paginasCopia
            + ';' + c.escaneos + ';' + c.paginasEscaneo + ';' + (c.paginas + c.paginasCopia) + '\n';
        if (i > i0 && bytesUtf8(texto + linea) + margen > config.WEB_MAX_BYTES) {
            break;
        }
        texto += linea;
    }
    if (i >= lista.length) {
        const t = store.totales();
        if (lista.length) {
            texto += 'TOTAL;;;' + t.impresiones + ';' + t.paginas + ';' + t.copias + ';' + t.paginasCopia
                + ';' + t.escaneos + ';' + t.paginasEscaneo + ';' + (t.paginas + t.paginasCopia) + '\n';
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

/** Campo del nombre completo, con lo que ya haya escrito (o se estaba escribiendo). */
function camposDatos(v) {
    return campo('Nombre completo', '<input name="nombreCompleto" size="32" maxlength="' + config.NOMBRE_COMPLETO_MAX
        + '" value="' + escapar((v && v.nombreCompleto) || '') + '">')
        // El correo es opcional: sólo sirve para que pueda escanear a su correo.
        + campo('Correo', '<input name="correo" size="32" maxlength="'
            + config.CORREO_MAX + '" value="' + escapar((v && v.correo) || '') + '">');
}

/** `previo`: lo que se escribió, para no hacérselo repetir si algo no era válido. */
function paginaNuevo(token, msg, previo) {
    const n = store.usuarios().length;
    if (n >= config.USUARIOS_MAX && !msg) {
        msg = { ok: false, texto: avisoCapacidad(n) };
    }
    return documento('Nuevo usuario', token, 'usuarios', mensajeHtml(msg) + panel('Datos', formulario(token, 'alta',
        campo('Usuario', '<input name="nombre" maxlength="' + config.USUARIO_MAX + '" autocomplete="off" value="'
            + escapar((previo && previo.nombre) || '') + '">')
        + campo('PIN', campoPin()) + camposDatos(previo) + '<p><button class="p">Dar de alta</button></p>')
        + '<p class="k">Usuario: minúsculas, números y . _ - (el Nombre del driver). PIN: '
        + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos (la Contraseña del driver). '
        + 'El nombre completo es opcional.</p>'), ['usuarios', 'Usuarios']);
}

function paginaUsuario(token, nombre, msg) {
    const u = store.usuarios().filter((x) => x.nombre === nombre)[0];
    if (!u) {
        return paginaUsuarios(token, msg || { ok: false, texto: 'No existe el usuario ' + nombre + '.' });
    }
    const c = store.contadorDe(u.nombre);
    const inactivo = u.activo === false;
    const campoNombre = '<input type="hidden" name="nombre" value="' + escapar(u.nombre) + '">';
    return documento('Usuario ' + u.nombre, token, 'usuarios', mensajeHtml(msg)
        + '<p><span class="' + (inactivo ? 'r">desactivado' : 'g">activo') + '</span> ' + c.impresiones + ' impr. '
        + c.paginas + ' pág. · ' + c.copias + ' cop. ' + c.paginasCopia + ' pág. · '
        + c.escaneos + ' esc. ' + c.paginasEscaneo + ' pág.</p>'
        // Formularios separados: Enter en un campo pulsa el primer botón de SU formulario.
        + panel('Datos', formulario(token, 'cambiar', campoNombre + camposDatos(u)
            + '<p><button class="p" name="a" value="datos">Guardar</button></p>'))
        + panel('PIN y estado', formulario(token, 'cambiar', campoNombre + campo('PIN nuevo', campoPin())
            + '<p><button class="p" name="a" value="pin">Cambiar PIN</button>'
            + '<button name="a" value="' + (inactivo ? 'activar">Activar' : 'desactivar">Desactivar') + '</button>'
            + '<button class="x" name="a" value="borrar" onclick="return confirm(\'¿Borrar?\')">Borrar</button></p>')),
    ['usuarios', 'Usuarios']);
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                              */
/* ------------------------------------------------------------------ */

/** Mensaje de acciones.js ({ok, texto, nivel}) a mensaje de la web. */
function deAccion(r) {
    return { ok: r.ok, texto: r.texto };
}

/** Botón de un formulario de varias acciones (name="a"). */
function botonA(valor, texto, clase, confirmar) {
    return '<button' + (clase ? ' class="' + clase + '"' : '') + ' name="a" value="' + valor + '"'
        + (confirmar ? ' onclick="return confirm(\'' + confirmar + '\')"' : '') + '>' + texto + '</button>';
}

/**
 * Un solo formulario con un botón por acción (name="a"): cada ajuste es un botón que
 * lo cambia al otro valor, igual que en el panel.
 */
function paginaAjustes(token, msg) {
    const a = store.ajustes();
    const b = cerradura.impresionBloqueada();
    const minutos = config.MINUTOS_SESION_OPCIONES.map((m) => '<option' + (m === a.minutosSesion ? ' selected' : '')
        + '>' + m + '</option>').join('');
    const fila = (nombre, valor, boton) => '<tr><th>' + nombre + '</th><td><b>' + valor + '</b> ' + boton + '</td></tr>';
    return documento('Ajustes', token, 'ajustes', mensajeHtml(msg) + panel('Protección', formulario(token, 'ajuste',
        '<table>'
        + fila('Modo', a.modo === 'retencion' ? 'retención' : 'sesión',
            botonA('modo', a.modo === 'retencion' ? 'A sesión' : 'A retención'))
        + fila('Bloqueo', a.bloqueoActivo ? 'ENCENDIDO' : 'apagado', a.bloqueoActivo
            ? botonA('bloqueo', 'Apagar', 'x', '¿Apagar el bloqueo?') : botonA('bloqueo', 'Encender', 'p'))
        + fila('Copia', a.bloquearCopia ? 'con PIN' : 'libre', botonA('copia', a.bloquearCopia ? 'Libre' : 'Con PIN'))
        + fila('Escaneo', a.bloquearEscaneo ? 'con PIN' : 'libre', botonA('escaneo', a.bloquearEscaneo ? 'Libre' : 'Con PIN'))
        + fila('Sesión', '<select name="minutos">' + minutos + '</select> min', botonA('minutos', 'Guardar'))
        // En retención la impresión desde PC está siempre abierta (la vigila el guardián):
        // sólo informa en modo sesión.
        + '</table><p class="k">' + (a.modo === 'sesion' ? 'Impresión PC: ' + (b === null ? '¿?' : b ? 'bloqueada' : 'abierta') + '. ' : '')
        + botonA('desbloquear', 'Desbloquear', 'x', '¿Seguro?') + '</p>'))
        // Un formulario GET con un botón por destino: el token va una vez, no cuatro.
        + panel('Mantenimiento', '<form><input type="hidden" name="s" value="' + token + '">'
            + [['copia', 'Respaldo'], ['pinadmin', 'PIN admin'], ['carpeta', 'Carpeta']].map((x) => '<button formaction="' + x[0] + '">' + x[1] + '</button>').join('')
            + '</form>'));
}

/**
 * La carpeta compartida a donde va lo escaneado, con una subcarpeta por persona.
 * La contraseña no se devuelve nunca a la página: se enseña si hay una guardada y se
 * deja en blanco para no tocarla.
 */
function paginaCarpeta(token, msg) {
    const c = store.carpetaEscaneo() || {};
    const campoT = (etiq, nombre, valor, extra) => campo(etiq, '<input name="' + nombre + '" size="26" value="'
        + escapar(valor || '') + '"' + (extra || '') + '>');
    return documento('Carpeta de escaneos', token, 'ajustes', mensajeHtml(msg) + panel('Carpeta compartida',
        formulario(token, 'carpeta', campoT('Servidor o IP', 'servidor', c.servidor)
            + campoT('Carpeta', 'ruta', c.ruta) + campoT('Usuario', 'usuario', c.usuario)
            + campo('Contraseña', '<input name="clave" type="password" size="26" placeholder="'
                + (c.clave ? 'sin cambios' : '') + '">')
            + campoT('Puerto', 'puerto', c.puerto || 445, ' size="6"')
            + '<p><button class="p">Guardar</button>'
            + '<button class="x" name="quitar" value="1" onclick="return confirm(\'¿Quitar la carpeta?\')">Quitar</button></p>')
        + '<p class="k">Cada persona recibe lo suyo en una subcarpeta con su usuario. '
        + 'Use una cuenta que sólo pueda escribir ahí: la contraseña viaja en la copia de seguridad.</p>'),
    ['ajustes', 'Ajustes']);
}

function paginaPinAdmin(token, msg) {
    return documento('PIN de administrador', token, 'ajustes', mensajeHtml(msg) + panel('Cambiar PIN',
        formulario(token, 'pinadmin', campo('PIN actual', campoPin('actual'))
            + campo('PIN nuevo (' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos)', campoPin('nuevo'))
            + campo('Repita el PIN nuevo', campoPin('repetir')) + '<p><button class="p">Cambiar</button></p>')
        + '<p class="k">Vale para el panel de la impresora y para esta página. '
        + 'Si se olvida, sólo se recupera reinstalando la app (se pierden los datos).</p>'), ['ajustes', 'Ajustes']);
}

/** Acciones de /ajuste. */
function hacerAjuste(d) {
    const a = store.ajustes();
    switch (d.a) {
        case 'modo': return acciones.fijarModo(a.modo === 'retencion' ? 'sesion' : 'retencion');
        case 'bloqueo': return acciones.fijarBloqueo(!a.bloqueoActivo);
        case 'copia': return acciones.fijarBloqueoCopia(!a.bloquearCopia);
        case 'escaneo': return acciones.fijarBloqueoEscaneo(!a.bloquearEscaneo);
        case 'minutos': return acciones.fijarMinutosSesion(d.minutos);
        case 'desbloquear': return acciones.desbloquearTodo();
        default: return { ok: false, texto: 'Acción desconocida.' };
    }
}

/* ------------------------------------------------------------------ */
/* Copia de seguridad desde el navegador (sin servidor en el PC)        */
/* ------------------------------------------------------------------ */

/*
 * DESCARGAR: la copia no cabe en una respuesta (tope de salida, ~2 KB), así que el
 * navegador la pide por partes, como el CSV. La copia se congela al pedir la primera
 * parte: si entre parte y parte se contara un trabajo, las piezas no casarían.
 *
 * SUBIR: el tope de ENTRADA es mucho menor. Medido el 21-09-2026: un POST de 502 bytes
 * llega; uno de 1002 CUELGA la web hasta reiniciar la impresora (no falla limpio: el
 * firmware se queda colgado antes de que la app lo vea, así que la app no puede
 * protegerse). Por eso el navegador manda la copia en trozos de config.WEB_TROZO_SUBIDA
 * caracteres, en base64url (sin caracteres que haya que escapar: el tamaño es exacto).
 */

/** token -> copia congelada (texto JSON) mientras se descarga. */
const descargas = new Map();
/** token -> {id, total, partes[]} mientras se sube. */
const subidas = new Map();

export function parteCopia(token, desde) {
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    if (i0 === 0 || !descargas.has(token)) {
        descargas.set(token, JSON.stringify(store.respaldo()));
    }
    const r = parteTexto(descargas.get(token), i0);
    if (/^SIGUIENTE;-1/.test(r)) {
        descargas.delete(token);
    }
    return r;
}

/**
 * Un trozo de un texto largo que no cabe en una respuesta: "SIGUIENTE;<n o -1>\n" y el
 * trozo. Se corta por caracteres contando bytes: un acento no puede quedar partido.
 */
export function parteTexto(texto, desde) {
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    let i = i0;
    let bytes = 0;
    const max = config.WEB_MAX_BYTES - 40;
    while (i < texto.length) {
        const b = bytesUtf8(texto.charAt(i));
        if (bytes + b > max) break;
        bytes += b;
        i++;
    }
    return 'SIGUIENTE;' + (i >= texto.length ? -1 : i) + '\n' + texto.slice(i0, i);
}

/*
 * CARGADOR DE SCRIPTS por partes: los scripts grandes (leer un Excel, revisar la
 * importación) no caben en una respuesta. La página trae este cargador en línea, que
 * pide cada script con /js?n=<nombre>&desde=..., los junta y los ejecuta de una vez.
 */
function cargador(nombres) {
    return '<script>(function(N){var t="";function p(k,d){fetch("' + estatico('js') + '&n="+N[k]+"&desde="+d).then(function(r){return r.text()})'
        + '.then(function(x){var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);t+=x.slice(m[0].length);if(+m[1]>=0)return p(k,+m[1]);'
        + 't+="\\n";if(k+1<N.length)return p(k+1,0);var s=document.createElement("script");s.text=t;document.head.appendChild(s)})}'
        + 'addEventListener("load",function(){p(0,0)})})(' + JSON.stringify(nombres) + ')</script>';
}

/*
 * Scripts de una página, pedidos DESPUÉS de que carguen los estilos (evento load). La
 * impresora atiende de una en una (~1,15 s cada petición) y da por perdida la que espera
 * más de ~5 s ("app response time out"): con la página, las dos hojas de estilo y dos
 * scripts pedidos a la vez, la última hoja de estilo se perdía y la tabla salía sin
 * estilo (visto el 22-09-2026). Así no hay más de dos o tres peticiones en cola.
 * async=false: se ejecutan en orden.
 */
/*
 * Botón que carga su script al pulsarlo, no al abrir la página: así ninguna página pide
 * más de dos ficheros (la impresora atiende de una en una y descarta lo que espera más
 * de ~5 s: con más ficheros se perdía uno y la página salía sin estilo o sin la lista).
 * La primera pulsación tarda algo más; las siguientes, nada.
 */
function botonJs(token, fichero, funcion, clase, texto) {
    return '<button class="' + clase + '" data-s="' + token + '" onclick="J(this,\'' + estatico(fichero)
        + '\',\'' + funcion + '\')">' + texto + '</button>';
}

const CARGA_JS = '<script>function J(b,u,f){if(window[f])return window[f](b);b.disabled=true;'
    + 'var s=document.createElement("script");s.src=u;s.onload=function(){b.disabled=false;window[f](b)};'
    + 's.onerror=function(){b.disabled=false;alert("No se pudo cargar: reinténtelo")};document.body.appendChild(s)}</script>';

function scripts(ficheros) {
    return '<script>addEventListener("load",function(){' + JSON.stringify(ficheros.map(estatico))
        + '.forEach(function(u){var s=document.createElement("script");s.src=u;s.async=false;document.body.appendChild(s)})})</script>';
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url -> texto UTF-8. Este motor no trae atob ni TextDecoder. */
export function desdeBase64url(t) {
    return textoUtf8(bytesDeBase64url(t));
}

export function bytesDeBase64url(t) {
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < t.length; i++) {
        const v = B64.indexOf(t.charAt(i));
        if (v < 0) throw new Error('carácter no válido en la copia');
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }
    return bytes;
}

/** Bytes UTF-8 -> texto. Tampoco hay TextDecoder en este motor. */
export function textoUtf8(bytes) {
    const trozos = [];
    let s = '';
    for (let i = 0; i < bytes.length;) {
        const c = bytes[i];
        let cp;
        let n;
        if (c < 0x80) { cp = c; n = 1; }
        else if (c >= 0xf0) { cp = c & 0x07; n = 4; }
        else if (c >= 0xe0) { cp = c & 0x0f; n = 3; }
        else { cp = c & 0x1f; n = 2; }
        for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
        i += n;
        s += cp > 0xffff
            ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff))
            : String.fromCharCode(cp);
        if (s.length > 4096) {
            trozos.push(s);
            s = '';
        }
    }
    trozos.push(s);
    return trozos.join('');
}

/** Aplica una copia completa: datos con store, modo y bloqueo con acciones (como el panel). */
function aplicarCopia(copia) {
    const r = store.restaurarTodo(copia);
    if (!r.ok) {
        return { ok: false, texto: r.error };
    }
    const partes = [];
    const u = r.usuarios;
    partes.push(u.creados + ' usuario(s) nuevos, ' + u.actualizados + ' actualizados'
        + (u.malos ? ', ' + u.malos + ' no válidos' : '')
        + (u.sinSitio ? ', ' + u.sinSitio + ' sin crear por el máximo de ' + config.USUARIOS_MAX : ''));
    partes.push(r.contadores ? 'contadores restaurados' : 'contadores: se conservan los actuales');
    const m = acciones.fijarModo(r.aplicar.modo);
    if (!m.ok) partes.push('modo: ' + m.texto);
    const b = acciones.fijarBloqueo(r.aplicar.bloqueoActivo);
    if (!b.ok) partes.push('bloqueo: ' + b.texto);
    return { ok: m.ok && b.ok, texto: 'Copia restaurada: ' + partes.join('; ') + '.' };
}

/**
 * Aplica una importación ya revisada en el navegador: {filas: [[fila, usuario, pin,
 * nombreCompleto], ...]}. La impresora vuelve a validar cada fila con las
 * mismas reglas que el alta manual: la revisión del navegador es para el usuario, no
 * una garantía.
 */
function aplicarImportacion(datos) {
    if (!datos || !Array.isArray(datos.filas)) {
        return { ok: false, texto: 'El fichero no trae usuarios.' };
    }
    const filas = datos.filas.filter(Array.isArray).map((a) => ({
        fila: a[0], usuario: String(a[1] || ''), pin: String(a[2] === undefined ? '' : a[2]),
        nombreCompleto: String(a[3] || ''),
    }));
    const r = store.importarUsuarios(filas);
    const partes = [r.creados + ' usuario(s) creados'];
    if (r.existentes.length) partes.push(r.existentes.length + ' ya existían y se dejaron igual');
    if (r.errores.length) {
        partes.push(r.errores.length + ' con errores: ' + r.errores.slice(0, 5)
            .map((e) => 'fila ' + e.fila + ' (' + e.usuario + ': ' + e.error + ')').join(', ')
            + (r.errores.length > 5 ? '…' : ''));
    }
    return { ok: r.errores.length === 0, texto: partes.join('; ') + '.' };
}

/** Un trozo de la subida. Contesta "SIGUE;<i>", "OK;<texto>" o "ERROR;<texto>". */
export function trozoSubida(token, d) {
    const i = Math.floor(Number(d.i));
    const total = Math.floor(Number(d.t));
    const trozo = String(d.d || '');
    if (!(total >= 1 && total <= config.WEB_SUBIDA_MAX_TROZOS) || !(i >= 0 && i < total)
        || trozo.length > config.WEB_TROZO_SUBIDA || !/^[A-Za-z0-9_-]*$/.test(trozo)) {
        subidas.delete(token);
        return 'ERROR;Trozo no válido. Vuelva a intentarlo.';
    }
    if (i === 0) {
        // z=1: el navegador lo comprimió (deflate-raw); k: qué se sube.
        subidas.set(token, { id: String(d.u || ''), total, partes: [], z: d.z === '1',
            k: d.k === 'importar' ? 'importar' : 'copia' });
    }
    const s = subidas.get(token);
    if (!s || s.id !== String(d.u || '') || s.total !== total || s.partes.length !== i) {
        subidas.delete(token);
        return 'ERROR;La subida se desordenó. Vuelva a intentarlo.';
    }
    s.partes.push(trozo);
    if (s.partes.length < total) {
        return 'SIGUE;' + i;
    }
    subidas.delete(token);
    let datos;
    try {
        const bytes = bytesDeBase64url(s.partes.join(''));
        datos = JSON.parse(textoUtf8(s.z ? inflar(bytes) : bytes));
    } catch (e) {
        return 'ERROR;El fichero no es válido (' + String((e && e.message) || e).slice(0, 60) + ').';
    }
    const r = s.k === 'importar' ? aplicarImportacion(datos) : aplicarCopia(datos);
    console.log('[web] ' + s.k + ' subida (' + total + ' trozos' + (s.z ? ', comprimida' : '') + '): ' + r.texto);
    return (r.ok ? 'OK;' : 'ERROR;') + r.texto;
}

function paginaCopia(token, msg) {
    return documento('Copia de seguridad', token, 'ajustes', mensajeHtml(msg)
        + panel('Descargar', '<p>Guarda en este PC una copia con usuarios, PIN, nombres, contadores y ajustes.</p>'
            + botonJs(token, 'copia-bajar.js', 'bajarCopia', 'p', 'Descargar copia'))
        + panel('Subir', '<p>Deja la impresora como estaba en esa copia (p. ej. tras reinstalar). No borra a nadie.</p>'
            + '<p><input type="file" id="f" accept=".json"></p>'
            + botonJs(token, 'copia-subir.js', 'subirCopia', 'p', 'Subir copia') + '<p id="e"></p>')
        + '<p class="k">La copia lleva los PIN (cifrados de forma débil): guárdela como confidencial.</p>'
        + CARGA_JS,
    ['ajustes', 'Ajustes']);
}

/*
 * El script del navegador. Descargar: igual que el CSV. Subir: lee el fichero,
 * comprueba que es JSON, lo pasa a base64url y lo manda trozo a trozo, esperando
 * cada respuesta antes del siguiente (el orden importa).
 */
const COPIA_BAJAR_JS = 'function bajarCopia(b){var s=b.getAttribute("data-s"),t="";b.disabled=true;'
    + 'function p(n){fetch("copia.json?s="+s+"&desde="+n).then(function(r){return r.text()}).then(function(x){'
    + 'var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m){b.disabled=false;return alert("La sesión caducó, vuelva a entrar")}'
    + 't+=x.slice(m[0].length);if(+m[1]>=0)return p(+m[1]);b.disabled=false;'
    + 'var d=new Date(),f=d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2),'
    + 'a=document.createElement("a");a.href=URL.createObjectURL(new Blob([t],{type:"application/json"}));'
    + 'a.download="copia-impresora-"+f+".json";document.body.appendChild(a);a.click();a.remove()'
    + '}).catch(function(e){b.disabled=false;alert("No se pudo descargar: "+e)})}p(0)}';
/* En dos ficheros: juntos pasan del tope de una respuesta. */
const COPIA_SUBIR_JS = 'function $(i){return document.getElementById(i)}'
    + 'function subirCopia(b){var s=b.getAttribute("data-s"),e=$("e"),f=$("f").files[0];'
    + 'if(!f)return e.textContent="Elija primero el fichero de la copia.";'
    + 'if(!confirm("¿Restaurar la impresora con "+f.name+"?"))return;'
    + 'f.text().then(function(t){try{JSON.parse(t)}catch(x){return e.textContent="Ese fichero no es una copia (no es JSON)."}'
    + 'subir(s,"copia",t,e,b)})}';

/*
 * Subida por trozos, común a la copia y a la importación. Si el navegador sabe
 * (CompressionStream: Chrome, Edge, Firefox y Safari actuales), comprime antes: una
 * copia de 1000 usuarios pasa de ~280 KB a ~30 KB y de ~1500 envíos a ~160. Si no,
 * manda sin comprimir, como antes. La impresora lo sabe por z=1.
 */
const SUBIR_JS = 'function subir(s,k,t,e,b){var z=typeof CompressionStream=="function",'
    + 'bl=new Blob([t]);b.disabled=true;e.className="";e.textContent="Preparando…";'
    + '(z?new Response(bl.stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer():bl.arrayBuffer())'
    + '.then(function(a){var u=new Uint8Array(a),x="",i;for(i=0;i<u.length;i+=8192)x+=String.fromCharCode.apply(null,u.subarray(i,i+8192));'
    + 'var c=btoa(x).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""),'
    + 'n=' + config.WEB_TROZO_SUBIDA + ',tot=Math.max(1,Math.ceil(c.length/n)),id=Math.random().toString(36).slice(2,10);'
    + 'function p(i){e.textContent="Subiendo… "+Math.round(100*i/tot)+"%";'
    + 'fetch("subir",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},'
    + 'body:"s="+s+"&k="+k+"&z="+(z?1:0)+"&u="+id+"&i="+i+"&t="+tot+"&d="+c.substr(i*n,n)}).then(function(r){return r.text()}).then(function(x){'
    + 'if(/^SIGUE;/.test(x))return p(i+1);b.disabled=false;'
    + 'if(/^(OK|ERROR);/.test(x)){e.textContent=x.slice(x.indexOf(";")+1);e.className=x[0]=="O"?"ok":"error"}'
    + 'else e.textContent="La sesión caducó, vuelva a entrar."'
    + '}).catch(function(x){b.disabled=false;e.textContent="Error de red: "+x})}p(0)})}';

/* Importar usuarios desde Excel                                        */
/* ------------------------------------------------------------------ */

/*
 * El Excel lo lee EL NAVEGADOR: un .xlsx es un ZIP con XML, y los navegadores actuales
 * traen DecompressionStream y DOMParser, así que no hace falta ninguna librería ni
 * internet. La impresora sólo recibe la lista ya leída (subida comprimida por trozos,
 * como la copia) y vuelve a validar cada fila con las reglas del alta manual.
 */

function paginaImportar(token, msg) {
    return documento('Importar usuarios', token, 'usuarios', mensajeHtml(msg)
        + panel('1. Plantilla', '<p>Descárguela y rellénela en Excel, una persona por fila.</p>'
            + '<button data-s="' + token + '" onclick="bajarPlantilla(this)">Descargar plantilla</button>')
        + panel('2. Revisar', '<p><input type="file" id="f" accept=".xlsx,.csv"></p><button onclick="revisar()">Revisar</button>'
            + '<div class="t" id="v"></div>')
        + panel('3. Importar', '<button class="p" id="b" data-s="' + token + '" disabled onclick="importar(this)">Importar</button> '
            + '<span id="e"></span><p class="k">Los que ya existen se saltan sin cambiarlos. El Excel lleva los PIN en claro: '
            + 'bórrelo o guárdelo como confidencial.</p>')
        + cargador(['tabla', 'subir', 'importar']), ['usuarios', 'Usuarios']);
}

/** La plantilla (src/plantilla.js), en trozos de base64 que caben en una respuesta. */
export function partePlantilla(desde) {
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    const trozo = config.WEB_MAX_BYTES - 40;
    const fin = Math.min(PLANTILLA_XLSX_B64.length, i0 + trozo);
    return 'SIGUIENTE;' + (fin >= PLANTILLA_XLSX_B64.length ? -1 : fin) + '\n' + PLANTILLA_XLSX_B64.slice(i0, fin);
}

/*
 * tabla.js: leerTabla(fichero) -> Promise de [{n: fila, c: [celdas]}]. Un .xlsx se abre
 * a mano: se busca el directorio del ZIP, se descomprimen la primera hoja y los textos
 * compartidos, y se leen las celdas por su referencia (B3 -> columna 1). Un .csv se
 * parte por ; o , (lo que más haya en la primera línea), respetando las comillas.
 */
const TABLA_JS = 'function leerTabla(f){return/\\.(csv|txt)$/i.test(f.name)?f.text().then(leerCsv):f.arrayBuffer().then(leerXlsx)}'
    + 'function leerCsv(t){t=t.replace(/^\\ufeff/,"");var l0=t.split("\\n")[0],s=l0.split(";").length>=l0.split(",").length?";":",",'
    + 'R=[],f=[],c="",q=0,i,ch;for(i=0;i<=t.length;i++){ch=t[i];if(q){if(ch==\'"\'){if(t[i+1]==\'"\'){c+=ch;i++}else q=0}else c+=ch}'
    + 'else if(ch==\'"\')q=1;else if(ch==s)f.push(c),c="";else if(ch=="\\n"||ch===undefined){f.push(c.replace(/\\r$/,""));R.push({n:R.length+1,c:f});f=[];c=""}else c+=ch}return R}'
    + 'function leerXlsx(b){var v=new DataView(b),u=new Uint8Array(b),T=new TextDecoder(),e=b.byteLength-22,F={},i,o,n;'
    + 'while(e>=0&&v.getUint32(e,true)!=0x06054b50)e--;if(e<0)throw"no es un Excel .xlsx";n=v.getUint16(e+10,true);o=v.getUint32(e+16,true);'
    + 'for(i=0;i<n;i++){var nl=v.getUint16(o+28,true);F[T.decode(u.subarray(o+46,o+46+nl))]={m:v.getUint16(o+10,true),c:v.getUint32(o+20,true),'
    + 'l:v.getUint32(o+42,true)};o+=46+nl+v.getUint16(o+30,true)+v.getUint16(o+32,true)}'
    + 'function leer(k){var x=F[k];if(!x)return Promise.resolve("");var d=x.l+30+v.getUint16(x.l+26,true)+v.getUint16(x.l+28,true),r=u.subarray(d,d+x.c);'
    + 'return(x.m?new Response(new Blob([r]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer():Promise.resolve(r))'
    + '.then(function(a){return T.decode(a)})}'
    + 'var h=Object.keys(F).filter(function(k){return/^xl\\/worksheets\\/sheet\\d+\\.xml$/.test(k)}).sort(function(a,b){return a.match(/\\d+/)-b.match(/\\d+/)})[0];'
    + 'if(!h)throw"el Excel no tiene hojas";return Promise.all([leer("xl/sharedStrings.xml"),leer(h)]).then(function(r){var P=new DOMParser(),S=[],R=[],x=function(t){return P.parseFromString(t,"text/xml")};'
    + 'if(r[0])[].forEach.call(x(r[0]).getElementsByTagName("si"),function(s){S.push([].map.call(s.getElementsByTagName("t"),function(t){return t.parentNode.nodeName=="rPh"?"":t.textContent}).join(""))});'
    + '[].forEach.call(x(r[1]).getElementsByTagName("row"),function(w){var f=[];[].forEach.call(w.getElementsByTagName("c"),function(c){'
    + 'var m=/^[A-Z]+/.exec(c.getAttribute("r")||""),k=0,j,t=c.getAttribute("t"),V=c.getElementsByTagName("v")[0];if(m)for(j=0;j<m[0].length;j++)k=k*26+m[0].charCodeAt(j)-64;'
    + 'f[m?k-1:f.length]=t=="s"?S[+V.textContent]:t=="inlineStr"?c.textContent:V?V.textContent:""});R.push({n:+w.getAttribute("r")||R.length+1,c:f})});return R})}';

/*
 * importar.js: revisa cada fila con las MISMAS reglas que el alta (la impresora las
 * vuelve a aplicar), enseña la vista previa sin mostrar los PIN, y sube sólo lo válido.
 * Si la primera fila son títulos, las columnas se buscan por nombre; si no, van en el
 * orden de la plantilla: usuario, PIN, nombre completo.
 */
const IMPORTAR_JS = 'var L=[];function $(i){return document.getElementById(i)}'
    + 'function bajarPlantilla(b){var s=b.getAttribute("data-s"),t="";function p(n){fetch("plantilla.txt?s="+s+"&desde="+n).then(function(r){return r.text()}).then(function(x){'
    + 'var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m)return alert("La sesión caducó, vuelva a entrar");t+=x.slice(m[0].length);if(+m[1]>=0)return p(+m[1]);'
    + 'var y=atob(t),u=new Uint8Array(y.length),i,a=document.createElement("a");for(i=0;i<y.length;i++)u[i]=y.charCodeAt(i);'
    + 'a.href=URL.createObjectURL(new Blob([u],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));'
    + 'a.download="plantilla-usuarios.xlsx";document.body.appendChild(a);a.click();a.remove()})}p(0)}'
    + 'function existentes(s){var E={};function p(n){return fetch("usuarios.txt?s="+s+"&desde="+n).then(function(r){return r.text()}).then(function(x){'
    + 'var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m)throw"la sesión caducó, vuelva a entrar";x.slice(m[0].length).split("\\n").forEach(function(l){if(l)E[l.split("\\t")[0]]=1});'
    + 'return+m[1]>=0?p(+m[1]):E})}return p(0)}'
    + 'function revisar(){var f=$("f").files[0],e=$("e"),b=$("b");b.disabled=true;L=[];if(!f)return e.textContent="Elija el fichero.";e.className="";e.textContent="Leyendo…";'
    + 'Promise.all([leerTabla(f),existentes(b.getAttribute("data-s"))]).then(function(r){var R=r[0],E=r[1],K=[0,1,2],U={},nuevos=0,malos=0,ya=0,cab=R[0]&&R[0].c.join("|").toLowerCase();'
    + 'if(cab&&/usuario/.test(cab)){K=["usuario","pin","nombre"].map(function(k){return R[0].c.findIndex(function(x){return new RegExp(k).test(String(x||"").toLowerCase())})});R=R.slice(1)}'
    + 'var h="<table><tr><th>Fila</th><th>Usuario</th><th>Nombre</th><th>Estado</th></tr>",libres=' + config.USUARIOS_MAX + '-Object.keys(E).length;'
    + 'R.forEach(function(w){var g=function(i){return i<0?"":String(w.c[i]==null?"":w.c[i]).trim()},u=g(K[0]).toLowerCase(),p=g(K[1]),n=g(K[2]).replace(/\\s+/g," "),m="";'
    + 'if(!u&&!p&&!n)return;if(!/^[a-z0-9._-]{1,' + config.USUARIO_MAX + '}$/.test(u))m="usuario no válido";'
    + 'else if(!/^[0-9]{' + config.PIN_MIN + ',' + config.PIN_MAX + '}$/.test(p))m="PIN de ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' números";'
    + 'else if(n.length>' + config.NOMBRE_COMPLETO_MAX + '||/[<>;"]/.test(n))m="nombre no válido";'
    + 'else if(U[u])m="repetido en la fila "+U[u];'
    + 'var z=E[u]&&!m;if(!m&&!z&&nuevos>=libres)m="no cabe: máximo ' + config.USUARIOS_MAX + ' usuarios";U[u]=U[u]||w.n;'
    + 'if(m)malos++;else if(z)ya++;else{nuevos++;L.push([w.n,u,p,n])}'
    + 'h+="<tr"+(m?\' class="error"\':z?\' class="inactivo"\':"")+"><td>"+w.n+"</td><td>"+u.replace(/</g,"&lt;")+"</td><td>"+n.replace(/</g,"&lt;")+"</td><td>"+(m||(z?"ya existe: se salta":"nuevo"))+"</td></tr>"});'
    + '$("v").innerHTML=h+"</table>";e.textContent=nuevos+" nuevos, "+ya+" ya existen, "+malos+" con errores"+(malos?" (se importan sólo los válidos)":"");b.disabled=!nuevos'
    + '}).catch(function(x){e.className="error";e.textContent="No se pudo leer: "+x})}'
    + 'function importar(b){if(!L.length||!confirm("¿Dar de alta a "+L.length+" usuarios?"))return;subir(b.getAttribute("data-s"),"importar",JSON.stringify({filas:L}),$("e"),b);L=[]}';

/* ------------------------------------------------------------------ */
/* Rutas                                                                */
/* ------------------------------------------------------------------ */

/** Atiende una petición ya leída. Devuelve {codigo, tipo, cuerpo}. Exportada para las pruebas. */
export function atenderRuta(p, ahora) {
    const t = typeof ahora === 'number' ? ahora : Date.now();
    const d = p.datos;
    const html = (cuerpo) => ({ codigo: 200, tipo: 'text/html; charset=utf-8', cuerpo });

    // Estáticos: iguales para todos y versionados, así que el navegador los guarda (r.cache).
    const js = 'text/javascript; charset=utf-8';
    const estaticos = {
        '/estilo.css': ['text/css; charset=utf-8', () => ESTILO],
        '/logo.svg': ['image/svg+xml; charset=utf-8', () => LOGO],
        '/subir.js': [js, () => SUBIR_JS], '/copia-bajar.js': [js, () => COPIA_BAJAR_JS],
        '/copia-subir.js': [js, () => SUBIR_JS + ';' + COPIA_SUBIR_JS], '/contadores.js': [js, () => CONTADORES_JS],
        '/lista.js': [js, () => LISTA_JS], '/csv.js': [js, () => CSV_JS],
    }[p.ruta];
    if (estaticos) {
        return { codigo: 200, tipo: estaticos[0], cuerpo: estaticos[1](), cache: true };
    }
    if (p.ruta === '/js') {
        const trozo = { tabla: TABLA_JS, importar: IMPORTAR_JS, subir: SUBIR_JS }[d.n];
        return trozo ? { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteTexto(trozo, d.desde), cache: true }
            : { codigo: 404, tipo: 'text/plain', cuerpo: 'no existe' };
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

    // Todo lo que cambia algo va por POST: un enlace o una recarga no deben dar de alta ni borrar.
    const cambia = p.metodo === 'POST';
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
        return html(paginaContadores(token, null));
    }
    if (p.ruta === '/csv') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteCsv(d.desde) };
    }
    if (p.ruta === '/usuarios.txt') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteUsuarios(d.desde) };
    }
    if (p.ruta === '/importar') {
        return html(paginaImportar(token));
    }
    if (p.ruta === '/plantilla.txt') {
        return { codigo: 200, tipo: 'text/plain', cuerpo: partePlantilla(d.desde) };
    }
    if (p.ruta === '/copia') {
        return html(paginaCopia(token));
    }
    if (p.ruta === '/copia.json') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteCopia(token, d.desde) };
    }
    if (p.ruta === '/subir' && cambia) {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: trozoSubida(token, d) };
    }
    if (p.ruta === '/ajustes') {
        return html(paginaAjustes(token));
    }
    if (p.ruta === '/pinadmin' && !cambia) {
        return html(paginaPinAdmin(token));
    }
    if (p.ruta === '/carpeta' && !cambia) {
        return html(paginaCarpeta(token));
    }
    if (p.ruta === '/carpeta' && cambia) {
        const previa = store.carpetaEscaneo();
        // Contraseña en blanco = dejar la que había: la página nunca la muestra.
        const r = acciones.fijarCarpetaEscaneo(d.quitar ? null : {
            servidor: d.servidor, ruta: d.ruta, usuario: d.usuario, puerto: d.puerto,
            clave: d.clave || (previa && previa.clave) || '',
        });
        return html(paginaCarpeta(token, anotar(deAccion(r))));
    }
    if (p.ruta === '/nuevo') {
        return html(paginaNuevo(token));
    }
    if (p.ruta === '/usuario') {
        return html(paginaUsuario(token, nombre));
    }
    if (p.ruta === '/alta' && cambia) {
        const r = store.agregarUsuario(d.nombre, d.pin, { nombreCompleto: d.nombreCompleto, correo: d.correo });
        return r.ok
            ? html(paginaUsuarios(token, anotar({ ok: true, texto: 'Usuario ' + nombre + ' dado de alta.' })))
            : html(paginaNuevo(token, anotar({ ok: false, texto: r.error }), d));
    }
    if (p.ruta === '/lista' && cambia) {
        const x = String(d.x || '');
        const quien = store.normalizarUsuario(x.slice(2));
        const existe = store.usuarios().some((u) => u.nombre === quien);
        let msg;
        if (!existe) {
            msg = { ok: false, texto: 'No existe el usuario ' + quien + '.' };
        } else if (x.charAt(0) === 'e') {
            return html(paginaUsuario(token, quien));
        } else if (x.charAt(0) === 'b') {
            store.quitarUsuario(quien);
            msg = { ok: true, texto: quien + ' borrado. Sus contadores se conservan.' };
        } else if (x.charAt(0) === 'a' || x.charAt(0) === 'd') {
            store.activarUsuario(quien, x.charAt(0) === 'a');
            msg = { ok: true, texto: quien + (x.charAt(0) === 'a' ? ' activado.' : ' desactivado: ya no puede imprimir.') };
        } else {
            msg = { ok: false, texto: 'Acción desconocida.' };
        }
        console.log('[web] /lista ' + x.slice(0, 30) + ': ' + msg.texto);
        return html(paginaUsuarios(token, msg));
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
        if (d.a === 'datos') {
            const r = store.cambiarDatosUsuario(nombre, { nombreCompleto: d.nombreCompleto, correo: d.correo });
            msg = r.ok ? { ok: true, texto: 'Datos guardados.' } : { ok: false, texto: r.error };
        } else if (d.a === 'pin') {
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
    if (p.ruta === '/ajuste' && cambia) {
        return html(paginaAjustes(token, anotar(deAccion(hacerAjuste(d)))));
    }
    if (p.ruta === '/pinadmin' && cambia) {
        // Pide el PIN actual aunque ya haya sesión: una pestaña olvidada abierta no
        // debe bastar para quedarse con el equipo. Cuenta para el freno de intentos.
        const espera = store.esperaPorIntentos(FRENO, t);
        let msg;
        if (espera > 0) {
            msg = { ok: false, texto: 'Demasiados intentos. Espere ' + espera + ' min.' };
        } else if (!store.esPinAdmin(d.actual)) {
            store.anotarFallo(FRENO, t);
            msg = { ok: false, texto: 'El PIN actual no es correcto.' };
        } else if (!store.pinValido(d.nuevo)) {
            msg = { ok: false, texto: 'El PIN nuevo debe tener de ' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos.' };
        } else if (d.nuevo !== d.repetir) {
            msg = { ok: false, texto: 'Los dos PIN nuevos no coinciden.' };
        } else {
            store.olvidarFallos(FRENO);
            store.cambiarPinAdmin(d.nuevo);
            // Las demás sesiones abiertas con el PIN viejo se cierran.
            for (const k of Array.from(sesiones.keys())) {
                if (k !== token) sesiones.delete(k);
            }
            return html(paginaAjustes(token, anotar({ ok: true, texto: 'PIN de administrador cambiado. Vale ya también en el panel.' })));
        }
        return html(paginaPinAdmin(token, anotar(msg)));
    }
    if (p.ruta === '/cero' && cambia) {
        const t = store.totales();
        store.reiniciarContadores();
        return html(paginaContadores(token, anotar({ ok: true, texto: 'Contadores a cero (había '
            + (t.paginas + t.paginasCopia) + ' páginas).' })));
    }
    return html(paginaUsuarios(token, null));
}

const DEMASIADO = '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" '
    + 'content="width=device-width,initial-scale=1"><link rel="stylesheet" href="' + BASE + '/estilo.css"></head><body>'
    + '<main><p class="error">La respuesta no cabe en lo que la impresora puede enviar. Vuelva atrás.</p></main></body></html>';

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
    const cab = new h.Headers('Content-Type', r.tipo);
    // Estáticos: que el navegador los guarde (van versionados, ver versionEstaticos).
    if (r.cache && typeof cab.set === 'function') {
        cab.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return new h.Response(r.codigo, cab, r.cuerpo);
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
