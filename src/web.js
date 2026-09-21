/**
 * Panel de administración servido por la PROPIA impresora, como la web de Pantum:
 *
 *     http://<ip>/pedk/app_notify/impresion
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
import * as respaldo from './respaldo.js';
import * as capacidad from './capacidad.js';

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

const ESTILO = 'body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#222}'
    + 'header{background:#1f4e79;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}'
    + 'header h1{font-size:17px;margin:0}header a{color:#fff}'
    + 'main{padding:12px 16px;max-width:760px}'
    + '.caja{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin-bottom:12px}'
    + 'table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #e3e3e3;padding:6px}'
    + 'input{padding:5px;font-size:14px;margin:2px 0}button{padding:5px 10px;font-size:14px;cursor:pointer;margin:2px 0}'
    + 'td button{margin-right:4px}.ok{color:#1b7a2f}.error{color:#b3261e}.aviso{background:#fff4d6}.inactivo{color:#999}';

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
/** Un solo aviso para todos los "Borrar" de la lista: uno por fila no cabría. */
const BORRAR_CONFIRMA = ' onsubmit="var v=event.submitter.value;return v[0]!=\'b\'||confirm(\'¿Borrar a \'+v.slice(2)+\'?\')"';

function formulario(token, accion, campos, extra) {
    return '<form method="post" action="' + accion + '"' + (extra || '') + '><input type="hidden" name="s" value="' + token + '">'
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
    const reserva = 150;   // lo que ocupan "« Anterior · Página x de y · Siguiente »"
    const cortes = [0];
    let acumulado = '';
    for (let i = 0; i < filas.length; i++) {
        if (acumulado && bytesUtf8(armar(acumulado + filas[i], '', cortes.length - 1)) + reserva > config.WEB_MAX_BYTES) {
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
    return armar(filas.slice(cortes[n], hasta).join(''), pie, n);
}

/** Lista compacta de usuarios. */
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
    const cab = '<span>' + enlace(token, 'contadores', '', 'Contadores') + ' · '
        + enlace(token, 'ajustes', '', 'Ajustes') + ' · '
        + enlace(token, 'nuevo', '', 'Nuevo usuario') + ' · ' + enlace(token, 'salir', '', 'Salir') + '</span>';
    const aviso = store.pinAdminDeFabrica()
        ? '<p class="caja aviso">PIN de administrador de fábrica: cámbielo en Ajustes.</p>' : '';
    return documento('Usuarios (' + n + ')', cab, aviso + mensajeHtml(msg) + '<div class="caja">'
        + formulario(token, 'lista', '<table id="t" data-s="' + token + '"></table>', BORRAR_CONFIRMA)
        + '</div><script src="lista.js"></script>');
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
    + 'function b(v,x){var n=e("button",x);n.name="x";n.value=v;return n}'
    + 'function pinta(){if(!L.length)return T.appendChild(e("tr")).appendChild(e("td","No hay usuarios."));'
    + 'L.forEach(function(l){var f=l.split("\\t"),a=f[1]=="1",r=e("tr",0,a?"":"inactivo"),d=e("td");'
    + 'd.appendChild(e("b",f[0]));if(f[2]){d.appendChild(e("br"));d.appendChild(e("small",f[2]))}r.appendChild(d);'
    + 'r.appendChild(e("td",a?"activo":"desactivado"));d=e("td");d.appendChild(b("e "+f[0],"Editar"));'
    + 'd.appendChild(b((a?"d ":"a ")+f[0],a?"Desactivar":"Activar"));d.appendChild(b("b "+f[0],"Borrar"));'
    + 'r.appendChild(d);T.appendChild(r)})}'
    + 'function p(n){fetch("usuarios.txt?s="+s+"&desde="+n).then(function(r){return r.text()}).then(function(x){'
    + 'var m=/^SIGUIENTE;(-?\\d+)\\n/.exec(x);if(!m){T.textContent="La sesión caducó, vuelva a entrar.";return}'
    + 'x.slice(m[0].length).split("\\n").forEach(function(l){if(l)L.push(l)});if(+m[1]>=0)p(+m[1]);else pinta()})}'
    + 'p(0)})()';

/** Cómo se llama en pantalla y en el CSV a quien no se identificó. */
function persona(quien) {
    return quien === store.SIN_SESION ? 'Sin identificar' : quien;
}

/** Qué se ve de alguien en los contadores: su nombre completo, o por qué no hay. */
function detalle(c) {
    if (c.quien === store.SIN_SESION) return '';
    if (!c.existe) return 'usuario borrado';
    return c.nombreCompleto + (c.activo ? '' : ' (desactivado)');
}

function paginaContadores(token, msg, pagina) {
    const lista = store.contadoresDeTodos();
    const t = store.totales();
    const cab = '<span>' + enlace(token, 'usuarios', '', 'Usuarios') + ' · ' + enlace(token, 'salir', '', 'Salir') + '</span>';
    // Quien no ha impreso nada sale en gris: también es un dato.
    const filas = lista.map((c) => {
        const total = c.paginas + c.paginasCopia;
        const d = detalle(c);
        return '<tr' + (total ? '' : ' class="inactivo"') + '><td><b>' + escapar(persona(c.quien)) + '</b>'
            + (d ? '<br><small>' + escapar(d) + '</small>' : '') + '</td><td>' + c.impresiones
            + '</td><td>' + c.paginas + '</td><td>' + c.copias + '</td><td>' + c.paginasCopia + '</td><td>'
            + total + '</td></tr>';
    });
    const acciones = '<p><button data-s="' + token + '" onclick="bajarCsv(this)">Descargar CSV (Excel)</button></p>'
        + formulario(token, 'cero', '<button onclick="return confirm(\'¿Poner TODOS los contadores a cero? '
            + 'Descargue antes el CSV.\')">Poner a cero</button>');
    return paginarFilas(token, 'contadores', filas, pagina, (f, pie) => documento('Contadores', cab, mensajeHtml(msg)
        + '<div class="caja"><p>Total: <b>' + (t.paginas + t.paginasCopia) + '</b> pág. (' + t.paginas + ' impresas, '
        + t.paginasCopia + ' copiadas)</p>'
        + (lista.length
            ? '<table><tr><td>Persona</td><td>Impr.</td><td>Pág.</td><td>Copias</td><td>Pág. copia</td><td>Total</td></tr>'
                + f + '</table>'
            : 'No hay usuarios ni nada contado.')
        + pie + '</div><div class="caja">' + acciones + '</div><script src="csv.js"></script>'));
}

/*
 * CSV por partes: un CSV con mucha gente no cabe en una respuesta. El navegador pide
 * /csv?desde=0, luego desde=<siguiente>... y lo junta en un solo fichero. Mismo formato
 * que respaldos/contadores.csv del servidor de respaldo: ';' y BOM para Excel en español.
 * La primera línea de cada parte es "SIGUIENTE;<índice o -1>" y el navegador la quita.
 */
export function parteCsv(desde) {
    const lista = store.contadoresDeTodos();
    const i0 = Math.max(0, Math.floor(Number(desde)) || 0);
    let texto = i0 === 0
        ? 'Usuario;Nombre completo;Cedula;Estado;Impresiones;Paginas impresas;Copias;Paginas copiadas;TOTAL paginas\n' : '';
    let i = i0;
    const margen = 120;   // la línea SIGUIENTE y la de TOTAL
    for (; i < lista.length; i++) {
        const c = lista[i];
        const estado = c.quien === store.SIN_SESION ? '' : !c.existe ? 'borrado' : c.activo ? 'activo' : 'desactivado';
        const linea = [persona(c.quien), c.nombreCompleto, c.cedula, estado]
            .map((x) => String(x).replace(/[;\r\n"]/g, ' ')).join(';')
            + ';' + c.impresiones + ';' + c.paginas + ';'
            + c.copias + ';' + c.paginasCopia + ';' + (c.paginas + c.paginasCopia) + '\n';
        if (i > i0 && bytesUtf8(texto + linea) + margen > config.WEB_MAX_BYTES) {
            break;
        }
        texto += linea;
    }
    if (i >= lista.length) {
        const t = store.totales();
        if (lista.length) {
            texto += 'TOTAL;;;;' + t.impresiones + ';' + t.paginas + ';' + t.copias + ';' + t.paginasCopia + ';'
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

/** Campos de nombre completo y cédula, con lo que ya haya escrito (o se estaba escribiendo). */
function camposDatos(v) {
    return '<input name="nombreCompleto" placeholder="Nombre y apellidos" size="28" maxlength="'
        + config.NOMBRE_COMPLETO_MAX + '" value="' + escapar((v && v.nombreCompleto) || '') + '"> '
        + '<input name="cedula" placeholder="Cédula" size="12" maxlength="20" value="'
        + escapar((v && v.cedula) || '') + '"> ';
}

/** `previo`: lo que se escribió, para no hacérselo repetir si algo no era válido. */
function paginaNuevo(token, msg, previo) {
    return documento('Nuevo usuario', enlace(token, 'usuarios', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja">' + formulario(token, 'alta',
            '<p><input name="nombre" placeholder="usuario" maxlength="' + config.USUARIO_MAX + '" autocomplete="off" value="'
            + escapar((previo && previo.nombre) || '') + '"> ' + campoPin('PIN') + '</p><p>' + camposDatos(previo)
            + '</p><button>Dar de alta</button>')
        + '<p><small>Usuario: minúsculas, números y . _ - (el Nombre del driver). PIN: '
        + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos (la Contraseña del driver). '
        + 'Nombre y cédula son para saber quién es.</small></p></div>');
}

function paginaUsuario(token, nombre, msg) {
    const u = store.usuarios().filter((x) => x.nombre === nombre)[0];
    if (!u) {
        return paginaUsuarios(token, msg || { ok: false, texto: 'No existe el usuario ' + nombre + '.' });
    }
    const c = store.contadorDe(u.nombre);
    const inactivo = u.activo === false;
    const campoNombre = '<input type="hidden" name="nombre" value="' + escapar(u.nombre) + '">';
    return documento('Usuario ' + u.nombre, enlace(token, 'usuarios', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja"><p><b>' + escapar(u.nombreCompleto || '(sin nombre completo)') + '</b>'
        + (u.cedula ? ' · Cédula ' + escapar(u.cedula) : '') + '</p><p>'
        + (inactivo ? 'Desactivado' : 'Activo') + ' · ' + c.impresiones
        + ' impresiones, ' + c.paginas + ' pág. · ' + c.copias + ' copias, ' + c.paginasCopia + ' pág.</p>'
        // Formularios separados: Enter en un campo pulsa el primer botón de SU formulario.
        + formulario(token, 'cambiar', campoNombre + camposDatos(u) + '<button name="a" value="datos">Guardar datos</button>')
        + formulario(token, 'cambiar', campoNombre
            + campoPin('PIN nuevo') + '<button name="a" value="pin">Cambiar PIN</button><p>'
            + '<button name="a" value="' + (inactivo ? 'activar">Activar' : 'desactivar">Desactivar') + '</button> '
            + '<button name="a" value="borrar" onclick="return confirm(\'¿Borrar?\')">Borrar</button></p>')
        + '</div>');
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                              */
/* ------------------------------------------------------------------ */

/** Mensaje de acciones.js ({ok, texto, nivel}) a mensaje de la web. */
function deAccion(r) {
    return { ok: r.ok, texto: r.texto };
}

/**
 * Un solo formulario con un botón por acción (name="a"): cada ajuste es un botón que
 * lo cambia al otro valor, igual que en el panel.
 */
function paginaAjustes(token, msg) {
    const a = store.ajustes();
    const b = cerradura.impresionBloqueada();
    const boton = (valor, texto, confirmar) => '<button name="a" value="' + valor + '"'
        + (confirmar ? ' onclick="return confirm(\'' + confirmar + '\')"' : '') + '>' + texto + '</button> ';
    const minutos = config.MINUTOS_SESION_OPCIONES.map((m) => '<option' + (m === a.minutosSesion ? ' selected' : '')
        + '>' + m + '</option>').join('');
    const cab = '<span>' + enlace(token, 'usuarios', '', 'Usuarios') + ' · ' + enlace(token, 'salir', '', 'Salir') + '</span>';
    return documento('Ajustes', cab, mensajeHtml(msg) + '<div class="caja">' + formulario(token, 'ajuste',
        '<p>Modo: <b>' + (a.modo === 'retencion' ? 'retención' : 'sesión') + '</b> '
        + boton('modo', a.modo === 'retencion' ? 'Pasar a sesión' : 'Pasar a retención') + '</p>'
        + '<p>Bloqueo: <b>' + (a.bloqueoActivo ? 'ENCENDIDO' : 'apagado') + '</b> '
        + boton('bloqueo', a.bloqueoActivo ? 'Apagar' : 'Encender', a.bloqueoActivo ? '¿Apagar? Cualquiera podrá imprimir.' : '')
        + '<br><small>Impresión desde PC: ' + (b === null ? 'no se sabe' : b ? 'bloqueada' : 'abierta') + '</small></p>'
        + '<p>Copia: <b>' + (a.bloquearCopia ? 'con PIN' : 'libre') + '</b> '
        + boton('copia', a.bloquearCopia ? 'Dejar libre' : 'Pedir PIN') + '</p>'
        + '<p>Sesión: <select name="minutos">' + minutos + '</select> min ' + boton('minutos', 'Guardar') + '</p>'
        + '<p>' + boton('desbloquear', 'Desbloquear equipo', '¿Desbloquear todo y apagar el bloqueo?') + '</p>')
        + '</div><div class="caja">' + enlace(token, 'copia', '', 'Copia de seguridad') + ' · '
        + enlace(token, 'pinadmin', '', 'PIN de administrador') + ' · '
        + enlace(token, 'respaldo', '', 'Respaldo automático (PC)') + ' · '
        + enlace(token, 'capacidad', '', 'Capacidad') + '</div>');
}

function paginaPinAdmin(token, msg) {
    const campo = (nombre, texto) => '<p>' + texto + '<br><input type="password" name="' + nombre
        + '" size="10" inputmode="numeric"></p>';
    return documento('PIN de administrador', enlace(token, 'ajustes', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja">' + formulario(token, 'pinadmin', campo('actual', 'PIN actual')
            + campo('nuevo', 'PIN nuevo (' + config.PIN_MIN + ' a ' + config.PIN_MAX + ' dígitos)')
            + campo('repetir', 'Repita el PIN nuevo') + '<button>Cambiar</button>')
        + '<p><small>Es el mismo PIN para el panel de la impresora y para esta página. '
        + 'Si se olvida, sólo se recupera reinstalando la app (se pierden los datos).</small></p></div>');
}

function paginaRespaldo(token, msg) {
    const e = respaldo.estado();
    const u = e.ultimo;
    const boton = (valor, texto, confirmar) => '<button name="a" value="' + valor + '"'
        + (confirmar ? ' onclick="return confirm(\'' + confirmar + '\')"' : '') + '>' + texto + '</button> ';
    return documento('Respaldo automático', enlace(token, 'ajustes', '', 'Volver') + ' · ' + enlace(token, 'respaldo', '', 'Actualizar'),
        mensajeHtml(msg) + '<div class="caja"><p>PC: <b>' + (e.destino ? escapar(e.destino) + ':' + config.RESPALDO_PUERTO : 'ninguno (apagado)')
        + '</b><br>Último: <span class="' + (u.ok === null ? '' : u.ok ? 'ok' : 'error') + '">'
        + escapar((u.cuando ? u.cuando + ' · ' : '') + u.detalle) + '</span>'
        + (e.enCurso ? '<br><b>En curso…</b> pulse Actualizar en unos segundos.' : '') + '</p>'
        + formulario(token, 'respaldo', '<p>IP del PC: <input name="ip" size="15" value="' + escapar(e.destino || '') + '"> '
            + boton('ip', 'Guardar') + boton('apagar', 'Apagar') + '</p><p>'
            + boton('subir', 'Respaldar ahora')
            + boton('restaurar', 'Restaurar último respaldo', '¿Devolver los usuarios del último respaldo, con su PIN?')
            + boton('altas', 'Alta de usuarios.json', '¿Dar de alta a la gente escrita en usuarios.json del PC?') + '</p>')
        + '<p><small>En el PC: Respaldo impresora.bat, abierto. El respaldo lleva los PIN: guárdelo como tal.</small></p></div>');
}

/** Acciones de /ajuste. */
function hacerAjuste(d) {
    const a = store.ajustes();
    switch (d.a) {
        case 'modo': return acciones.fijarModo(a.modo === 'retencion' ? 'sesion' : 'retencion');
        case 'bloqueo': return acciones.fijarBloqueo(!a.bloqueoActivo);
        case 'copia': return acciones.fijarBloqueoCopia(!a.bloquearCopia);
        case 'minutos': return acciones.fijarMinutosSesion(d.minutos);
        case 'desbloquear': return acciones.desbloquearTodo();
        default: return { ok: false, texto: 'Acción desconocida.' };
    }
}

/**
 * Acciones de /respaldo. Van a otro equipo y no esperan: la página enseña "En curso" y
 * el resultado aparece al pulsar Actualizar.
 */
function hacerRespaldo(d) {
    if (d.a === 'ip') {
        return respaldo.fijarDestino(String(d.ip || '').trim())
            ? { ok: true, texto: d.ip ? 'IP guardada.' : 'Respaldo apagado.' }
            : { ok: false, texto: 'IP no válida (ej. 192.168.0.10).' };
    }
    if (d.a === 'apagar') {
        respaldo.fijarDestino(null);
        return { ok: true, texto: 'Respaldo apagado.' };
    }
    if (!respaldo.destino()) {
        return { ok: false, texto: 'Ponga primero la IP del PC.' };
    }
    if (d.a === 'subir') {
        respaldo.exportar();
    } else if (d.a === 'restaurar') {
        respaldo.importar('restaurar');
    } else if (d.a === 'altas') {
        respaldo.importar('usuarios');
    } else {
        return { ok: false, texto: 'Acción desconocida.' };
    }
    return { ok: true, texto: 'Pedido al PC. Pulse Actualizar para ver cómo fue.' };
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
    const texto = descargas.get(token);
    // Se corta por caracteres, contando bytes: un acento no puede quedar partido.
    let i = i0;
    let bytes = 0;
    const max = config.WEB_MAX_BYTES - 40;
    while (i < texto.length) {
        const b = bytesUtf8(texto.charAt(i));
        if (bytes + b > max) break;
        bytes += b;
        i++;
    }
    if (i >= texto.length) {
        descargas.delete(token);
        return 'SIGUIENTE;-1\n' + texto.slice(i0);
    }
    return 'SIGUIENTE;' + i + '\n' + texto.slice(i0, i);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url -> texto UTF-8. Este motor no trae atob ni TextDecoder. */
export function desdeBase64url(t) {
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
    }
    return s;
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
        + (u.malos ? ', ' + u.malos + ' no válidos' : ''));
    partes.push(r.contadores ? 'contadores restaurados' : 'contadores: se conservan los actuales');
    const m = acciones.fijarModo(r.aplicar.modo);
    if (!m.ok) partes.push('modo: ' + m.texto);
    const b = acciones.fijarBloqueo(r.aplicar.bloqueoActivo);
    if (!b.ok) partes.push('bloqueo: ' + b.texto);
    return { ok: m.ok && b.ok, texto: 'Copia restaurada: ' + partes.join('; ') + '.' };
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
        subidas.set(token, { id: String(d.u || ''), total, partes: [] });
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
    let copia;
    try {
        copia = JSON.parse(desdeBase64url(s.partes.join('')));
    } catch (e) {
        return 'ERROR;El fichero no es una copia válida (' + String((e && e.message) || e).slice(0, 60) + ').';
    }
    const r = aplicarCopia(copia);
    console.log('[web] copia subida: ' + r.texto);
    return (r.ok ? 'OK;' : 'ERROR;') + r.texto;
}

function paginaCopia(token, msg) {
    return documento('Copia de seguridad', enlace(token, 'ajustes', '', 'Volver'), mensajeHtml(msg)
        + '<div class="caja"><p><b>Descargar</b> guarda en este PC una copia con usuarios, PIN, nombre, cédula, '
        + 'contadores y ajustes.</p><button data-s="' + token + '" onclick="bajarCopia(this)">Descargar copia</button></div>'
        + '<div class="caja"><p><b>Subir</b> deja la impresora como estaba en esa copia (p. ej. tras reinstalar). '
        + 'No borra a nadie.</p><input type="file" id="f" accept=".json"> '
        + '<button data-s="' + token + '" onclick="subirCopia(this)">Subir copia</button><p id="e"></p></div>'
        + '<p><small>La copia lleva los PIN (cifrados de forma débil) y las cédulas: guárdela como un documento '
        + 'confidencial.</small></p><script src="copia-bajar.js"></script><script src="copia-subir.js"></script>');
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
    + 'var c=btoa(unescape(encodeURIComponent(t))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""),'
    + 'n=' + config.WEB_TROZO_SUBIDA + ',tot=Math.ceil(c.length/n),u=Math.random().toString(36).slice(2,10);b.disabled=true;'
    + 'function p(i){e.textContent="Subiendo… "+Math.round(100*i/tot)+"%";'
    + 'fetch("subir",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},'
    + 'body:"s="+s+"&u="+u+"&i="+i+"&t="+tot+"&d="+c.substr(i*n,n)}).then(function(r){return r.text()}).then(function(x){'
    + 'if(/^SIGUE;/.test(x))return p(i+1);b.disabled=false;'
    + 'if(/^(OK|ERROR);/.test(x)){e.textContent=x.slice(x.indexOf(";")+1);e.className=x[0]=="O"?"ok":"error"}'
    + 'else e.textContent="La sesión caducó, vuelva a entrar."'
    + '}).catch(function(x){b.disabled=false;e.textContent="Error de red: "+x})}p(0)})}';

/* ------------------------------------------------------------------ */
/* Capacidad                                                            */
/* ------------------------------------------------------------------ */

function paginaCapacidad(token, msg) {
    const e = capacidad.estadoPrueba();
    const filas = e.pasos.map((r) => '<tr><td>' + r.n + '</td><td>' + (r.kb === null ? '-' : r.kb + ' KB')
        + '</td><td>' + (r.msGuardar === null ? '-' : r.msGuardar + ' ms') + '</td><td>'
        + (r.msLeer === null ? '-' : r.msLeer + ' ms') + '</td><td>' + (r.ok ? 'bien' : escapar(r.error || 'falla'))
        + '</td></tr>').join('');
    return documento('Capacidad', enlace(token, 'ajustes', '', 'Volver') + ' · ' + enlace(token, 'capacidad', '', 'Actualizar'),
        mensajeHtml(msg) + '<div class="caja"><p>Mide cuántos usuarios aguanta la impresora: guarda datos de prueba '
        + 'cada vez más grandes (en un fichero aparte, sus datos no se tocan) y cronometra. Mientras dura (≈1 min) '
        + 'la impresora puede ir lenta: que nadie imprima.</p>'
        + (e.enCurso ? '<p><b>En curso…</b> pulse Actualizar.</p>'
            : formulario(token, 'capacidad', '<button>Empezar la prueba</button>'))
        + (e.fin ? '<p><b>Resultado:</b> ' + escapar(e.fin) + '</p>' : '')
        + (filas ? '<table><tr><td>Usuarios</td><td>Tamaño</td><td>Guardar</td><td>Leer</td><td></td></tr>' + filas + '</table>' : '')
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
    if (p.ruta === '/copia-bajar.js' || p.ruta === '/copia-subir.js') {
        return { codigo: 200, tipo: 'text/javascript; charset=utf-8',
            cuerpo: p.ruta === '/copia-bajar.js' ? COPIA_BAJAR_JS : COPIA_SUBIR_JS };
    }
    if (p.ruta === '/lista.js') {
        return { codigo: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: LISTA_JS };
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
        return html(paginaContadores(token, null, d.p));
    }
    if (p.ruta === '/csv') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteCsv(d.desde) };
    }
    if (p.ruta === '/usuarios.txt') {
        return { codigo: 200, tipo: 'text/plain; charset=utf-8', cuerpo: parteUsuarios(d.desde) };
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
    if (p.ruta === '/capacidad') {
        if (cambia) {
            const o = acciones.impresoraOcupada();
            const msg = o ? { ok: false, texto: o.texto }
                : capacidad.empezar() ? { ok: true, texto: 'Prueba en marcha. Pulse Actualizar dentro de un minuto.' }
                    : { ok: false, texto: 'No se pudo empezar: ' + (capacidad.estadoPrueba().fin || 'ya está en curso') };
            return html(paginaCapacidad(token, anotar(msg)));
        }
        return html(paginaCapacidad(token));
    }
    if (p.ruta === '/ajustes') {
        return html(paginaAjustes(token));
    }
    if (p.ruta === '/pinadmin' && !cambia) {
        return html(paginaPinAdmin(token));
    }
    if (p.ruta === '/respaldo' && !cambia) {
        return html(paginaRespaldo(token));
    }
    if (p.ruta === '/nuevo') {
        return html(paginaNuevo(token));
    }
    if (p.ruta === '/usuario') {
        return html(paginaUsuario(token, nombre));
    }
    if (p.ruta === '/alta' && cambia) {
        const r = store.agregarUsuario(d.nombre, d.pin, { nombreCompleto: d.nombreCompleto, cedula: d.cedula });
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
            const r = store.cambiarDatosUsuario(nombre, { nombreCompleto: d.nombreCompleto, cedula: d.cedula });
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
    if (p.ruta === '/respaldo' && cambia) {
        return html(paginaRespaldo(token, anotar(hacerRespaldo(d))));
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
