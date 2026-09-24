/**
 * ESCANEAR DESDE LA APP, con el documento yendo a donde es de cada persona.
 *
 * Tres destinos, y en pantalla sólo salen los que de verdad se pueden usar:
 *
 *  - **Memoria USB**: siempre. No hace falta configurar nada.
 *  - **Mi carpeta**: la carpeta compartida que el administrador dio de alta una vez
 *    (servidor, usuario y contraseña), con una subcarpeta por persona. Así "su
 *    carpeta" no obliga a guardar una contraseña por cada usuario.
 *  - **Mi correo**: el correo de la ficha de la persona. Necesita que la impresora
 *    tenga su servidor de correo configurado (eso se hace en la web de Pantum).
 *
 * Medido el 25-09-2026 en la BM5220ADW: `new ScanJob(...)` acepta PC, EMAIL, SMB,
 * FTP, APP, HTTP y USB; la libreta del equipo (`pedk.addressbook`) existe y está
 * vacía. No hace falta llenarla: `AddressBookParam` mete el destino DENTRO del
 * trabajo. Y OJO con los parámetros: con sólo formato y color el equipo arrancaba el
 * trabajo y lo cancelaba solo a los 2 segundos; hay que mandar los cinco del ejemplo
 * de Pantum (tamaño, resolución, color, formato y dúplex).
 *
 * Como en copia.js, esta pantalla no cuenta nada: de eso se encarga el historial.
 */
import { COLOR, ambito, boton, etiqueta, pantalla, recortar } from './ui.js';
import { mostrar, repintar, pantallaActiva } from './router.js';
import { guard } from './guard.js';
import * as store from './store.js';

/** Los formatos que se ofrecen. Los números son del SDK: 0 JPEG, 1 PDF, 2 TIFF, 3 OFD. */
const FORMATOS = [
    { valor: 1, nombre: 'PDF' },
    { valor: 0, nombre: 'JPEG' },
];
/** Blanco y negro: este equipo no tiene color (`Color: false`), no hay nada que elegir. */
const COLOR_BN = 1;
/** 200 ppp (0:75, 1:150, 2:200, 3:300, 4:600, 5:1200): de sobra para papeles, y rápido. */
const RESOLUCION = 2;
/** Cuánto se espera a que el equipo cierre el trabajo antes de volver a ofrecer TERMINAR. */
const ESPERA_FIN_MS = 60000;

let alVolver = null;
let quien = '';
let destinos = [];
let iDestino = 0;
let iFormato = 0;
let trabajo = null;
/** true cuando la cancelación la pidió la persona, para no confundirla con la del equipo. */
let canceladoPorNosotros = false;
let estado = 'listo';
let mensaje = '';
let colorMensaje = COLOR.suave;
let woNum = 1;

function ns() {
    return (globalThis.pedk && pedk.jobs && pedk.jobs.scan) || null;
}

/** ¿Este firmware sabe escanear desde la app? */
export function disponible() {
    const s = ns();
    return !!(s && typeof s.ScanJob === 'function' && typeof s.ScanParameterSet === 'function');
}

function clave(nombre) {
    const s = ns();
    return (s && s[nombre]) || nombre;
}

/**
 * Los destinos que esta persona puede usar ahora mismo. La memoria USB siempre está;
 * los otros dos aparecen sólo si hay a dónde mandar: una carpeta dada de alta por el
 * administrador, y un correo en la ficha de quien ha entrado.
 */
export function destinosDe(usuario) {
    const lista = [{ id: 'usb', nombre: 'Memoria USB', tipo: 'SCAN_TO_USB' }];
    const c = store.carpetaEscaneo();
    if (c && c.servidor) {
        lista.push({ id: 'carpeta', nombre: 'Mi carpeta', tipo: 'SCAN_TO_SMB' });
    }
    const u = usuario ? store.usuario(usuario) : null;
    if (u && u.correo) {
        lista.push({ id: 'correo', nombre: 'Mi correo', tipo: 'SCAN_TO_EMAIL' });
    }
    return lista;
}

function ponerParametro(param, nombreClave, nombreClase, valor) {
    const s = ns();
    if (!s || typeof s[nombreClase] !== 'function') {
        console.log('[escaneo] sin ' + nombreClase + ': no se pide ' + nombreClave);
        return false;
    }
    try {
        const r = param.addParameter(clave(nombreClave), new s[nombreClase](valor));
        console.log('[escaneo] ' + nombreClave + '=' + valor + ' -> ' + r);
        return r !== false;
    } catch (e) {
        console.log('[escaneo] ' + nombreClave + ' lanzó: ' + String((e && e.message) || e).slice(0, 50));
        return false;
    }
}

/**
 * Mete el destino DENTRO del trabajo (`AddressBookParam`), que es lo que evita tener
 * que dar de alta a cada persona en la libreta del equipo.
 */
function ponerDestino(param, destino) {
    const s = ns();
    if (destino.id === 'usb') {
        return true;
    }
    if (typeof s.AddressBookParam !== 'function') {
        console.log('[escaneo] sin AddressBookParam: no se puede mandar a ' + destino.id);
        return false;
    }
    let abp = null;
    try {
        abp = new s.AddressBookParam();
    } catch (e) {
        console.log('[escaneo] AddressBookParam lanzó: ' + String((e && e.message) || e).slice(0, 40));
        return false;
    }
    try {
        if (destino.id === 'correo') {
            const u = store.usuario(quien);
            const r = abp.addMailAddr(String((u && u.correo) || ''));
            console.log('[escaneo] addMailAddr -> ' + r);
        } else {
            const c = store.carpetaEscaneo();
            // Subcarpeta por persona: la ruta base del administrador + el usuario.
            const ruta = String(c.ruta || '').replace(/[\\/]+$/, '') + '/' + quien;
            const r = abp.addSmbAddr(quien, c.servidor, c.usuario || '', ruta, c.clave || '',
                Number(c.puerto) || 445, !c.usuario);
            console.log('[escaneo] addSmbAddr(' + c.servidor + ', ' + ruta + ') -> ' + r);
        }
    } catch (e) {
        console.log('[escaneo] destino lanzó: ' + String((e && e.message) || e).slice(0, 44));
        return false;
    }
    try {
        const r = param.addParameter(clave('SCAN_PARAM_ADDRESSBOOKPARAM'), abp);
        console.log('[escaneo] SCAN_PARAM_ADDRESSBOOKPARAM -> ' + r);
        return r !== false;
    } catch (e) {
        console.log('[escaneo] libreta del trabajo lanzó: ' + String((e && e.message) || e).slice(0, 40));
        return false;
    }
}

function decir(texto, color) {
    mensaje = texto || '';
    colorMensaje = color || COLOR.suave;
}

function soltar() {
    canceladoPorNosotros = false;
    estado = 'listo';
    if (trabajo && trabajo.oyente) {
        try {
            trabajo.job.removeListener(trabajo.oyente);
        } catch (e) { /* el trabajo ya terminó */ }
    }
    trabajo = null;
    estado = 'listo';
}

function alEstado(bruto) {
    const s = String(bruto);
    console.log('[escaneo] estado: ' + s);
    if (s.indexOf('Running') >= 0) {
        estado = 'escaneando';
        decir('Escaneando. Al acabar la hoja, pulse TERMINAR.', COLOR.texto);
    } else if (s.indexOf('Finish') >= 0) {
        soltar();
        decir('Listo: ' + destinos[iDestino].nombre.toLowerCase() + '.', COLOR.ok);
    } else if (s.indexOf('Cancel') >= 0 || s.indexOf('Abort') >= 0) {
        const nuestro = canceladoPorNosotros;
        soltar();
        // Si nadie pulsó Cancelar, lo paró el equipo: no hay hoja, falta la memoria
        // USB o el destino no responde. Decirlo "cancelado" a secas despista.
        decir(nuestro ? 'Escaneo cancelado.' : 'El equipo paró el escaneo. Compruebe la hoja y el destino.',
            nuestro ? COLOR.aviso : COLOR.peligro);
    } else if (s.indexOf('Suspend') >= 0 || s.indexOf('Pause') >= 0) {
        decir('El equipo ha parado el escaneo. Mire su pantalla.', COLOR.peligro);
    }
    if (pantallaActiva() === 'escaneo') {
        repintar();
    }
}

/** Igual que en copia.js: el aviso se engancha en la instancia Y en el prototipo. */
function crearOyente() {
    const s = ns();
    const Clase = s && s.JobStateListener;
    const avisar = guard('escaneoEstado', alEstado);
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

function escanear() {
    const s = ns();
    if (estado !== 'listo' || !s || !destinos.length) {
        return;
    }
    const destino = destinos[iDestino];
    let param = null;
    try {
        param = new s.ScanParameterSet();
    } catch (e) {
        decir('El equipo no admite escanear desde aquí.', COLOR.peligro);
        console.log('[escaneo] ScanParameterSet lanzó: ' + String((e && e.message) || e).slice(0, 44));
        repintar();
        return;
    }
    /*
     * LOS CINCO PARÁMETROS, y en este orden, como el ejemplo del SDK.
     *
     * Medido el 25-09-2026: mandando sólo formato y color, el trabajo arrancaba
     * (`start -> 0`, Ready, Running) y **el equipo lo cancelaba solo a los 2 s**. El
     * ejemplo de Pantum manda además tamaño, resolución y dúplex, así que se mandan
     * los cinco. Cada uno va con su propio try/catch: si el firmware rechaza uno, se
     * ve en el log y los demás siguen.
     */
    ponerParametro(param, 'SCAN_PARAM_INPUTPAPERSIZE', 'InputPaperSize',
        (globalThis.MEDIA_SIZE && MEDIA_SIZE.MEDIA_SIZE_A4) || 'MEDIA_SIZE_A4');
    // El modo dice de dónde lee (0 automático, 2 alimentador, 3 cristal). El ejemplo de
    // Pantum no lo manda, pero su equipo no tiene alimentador y el nuestro sí: puede
    // ser justo lo que le falta para no cancelar el trabajo.
    ponerParametro(param, 'SCAN_PARAM_MODE', 'ScanMode', 0);
    ponerParametro(param, 'SCAN_PARAM_RESOLUTION', 'Resolution', RESOLUCION);
    ponerParametro(param, 'SCAN_PARAM_COLORTYPE', 'ColorType', COLOR_BN);
    ponerParametro(param, 'SCAN_PARAM_FILEFMTTYPE', 'FileFmtType', FORMATOS[iFormato].valor);
    ponerParametro(param, 'SCAN_PARAM_AUTODUPLEX', 'AutoDuplex', false);
    if (!ponerDestino(param, destino)) {
        decir('No se pudo preparar el destino.', COLOR.peligro);
        repintar();
        return;
    }

    let job = null;
    try {
        job = new s.ScanJob(s[destino.tipo] || destino.tipo);
    } catch (e) {
        decir('El equipo no admite ese destino.', COLOR.peligro);
        console.log('[escaneo] new ScanJob(' + destino.tipo + ') lanzó: '
            + String((e && e.message) || e).slice(0, 40));
        repintar();
        return;
    }
    const oyente = crearOyente();
    try {
        job.addListener(oyente);
    } catch (e) {
        console.log('[escaneo] addListener lanzó: ' + String((e && e.message) || e).slice(0, 44));
    }
    trabajo = { job, oyente };
    estado = 'escaneando';
    decir('Escaneando…', COLOR.texto);
    repintar();

    let r = null;
    try {
        // Tres argumentos, como el ejemplo del SDK: el cuarto (callback) sólo lo usa
        // SCAN_TO_APP y el firmware lo ignora si no es una función.
        r = job.start(woNum++, param, null);
    } catch (e) {
        r = 'lanzó ' + String((e && e.message) || e).slice(0, 40);
    }
    console.log('[escaneo] start(' + destino.tipo + ', ' + FORMATOS[iFormato].nombre + ') -> ' + r);
    if (r !== 0) {
        soltar();
        // 3 es permiso denegado y 4 escáner ocupado, según el SDK.
        decir(r === 4 ? 'El escáner está ocupado. Inténtelo en unos segundos.'
            : r === 3 ? 'El equipo no deja escanear a ese destino.'
                : 'No se pudo escanear (' + r + '). Mire la pantalla del equipo.', COLOR.peligro);
        repintar();
    }
}

/**
 * Contesta a la espera del equipo: otra página o se acabó.
 *
 * MEDIDO el 25-09-2026: con el puerto USB ya encendido, el trabajo llega a
 * `JBSts_Running` y SE QUEDA AHÍ (62 s hasta que la persona canceló). El escaneo
 * desde el cristal es de varias páginas y el firmware espera a que se le diga; para
 * eso están `continue()` y `finish()` de `ScanJob`, que hasta ahora no se llamaban.
 */
function seguir(otra) {
    if (!trabajo) {
        return;
    }
    const metodo = otra ? 'continue' : 'finish';
    if (typeof trabajo.job[metodo] !== 'function') {
        console.log('[escaneo] el equipo no trae ' + metodo + '()');
        decir('Este equipo no deja ' + (otra ? 'seguir' : 'terminar') + ' desde aquí.', COLOR.peligro);
        repintar();
        return;
    }
    if (!otra) {
        // Medido el 25-09-2026: `finish()` no devuelve nada y el equipo tardó ~50 s en
        // dar el trabajo por terminado (estaba acabando la hoja). Sin avisar, la
        // persona pulsa tres veces creyendo que no funcionó. Así que se esconden los
        // botones y se dice que espere; si tarda demasiado, vuelven a salir.
        estado = 'terminando';
        decir('Guardando el documento… puede tardar un poco.', COLOR.texto);
        setTimeout(guard('escaneoLento', () => {
            if (estado === 'terminando') {
                estado = 'escaneando';
                decir('Sigue sin terminar. Pulse TERMINAR otra vez.', COLOR.aviso);
                if (pantallaActiva() === 'escaneo') {
                    repintar();
                }
            }
        }), ESPERA_FIN_MS);
    } else {
        decir('Ponga la hoja siguiente…', COLOR.texto);
    }
    repintar();
    let r = null;
    try {
        r = trabajo.job[metodo]();
    } catch (e) {
        r = 'lanzó ' + String((e && e.message) || e).slice(0, 40);
    }
    console.log('[escaneo] ' + metodo + '() -> ' + r);
}

function cancelar() {
    if (!trabajo) {
        return;
    }
    canceladoPorNosotros = true;
    decir('Cancelando…', COLOR.aviso);
    try {
        trabajo.job.cancel();
    } catch (e) {
        console.log('[escaneo] cancel lanzó: ' + String((e && e.message) || e).slice(0, 44));
        soltar();
        decir('No se pudo cancelar. Use el botón del equipo.', COLOR.peligro);
    }
    repintar();
}

function render() {
    ambito('es');
    const w = [pantalla()];
    w.push(etiqueta('t', 12, 8, 300, 24, 'Escanear', COLOR.texto));
    w.push(boton('volver', 376, 6, 92, 32, 'Volver', COLOR.acento, () => {
        soltar();
        if (alVolver) {
            alVolver();
        }
    }));

    const ocupado = estado === 'escaneando';
    const terminando = estado === 'terminando';
    w.push(etiqueta('ld', 24, 74, 120, 24, 'Enviar a', COLOR.texto));
    if (destinos.length > 1) {
        w.push(boton('destino', 150, 62, 212, 44, destinos[iDestino].nombre, COLOR.acento, () => {
            iDestino = (iDestino + 1) % destinos.length;
            repintar();
        }));
    } else {
        w.push(etiqueta('destino1', 150, 74, 300, 24, destinos.length ? destinos[0].nombre : '—', COLOR.texto));
    }

    w.push(etiqueta('lf', 24, 134, 120, 24, 'Formato', COLOR.texto));
    w.push(boton('formato', 150, 124, 212, 40, FORMATOS[iFormato].nombre, COLOR.acento, () => {
        iFormato = (iFormato + 1) % FORMATOS.length;
        repintar();
    }));

    if (terminando) {
        // Nada que pulsar mientras el equipo guarda, salvo desistir.
        w.push(etiqueta('msg', 12, 200, 456, 44, recortar(mensaje, 62), colorMensaje));
        w.push(boton('cancelar', 24, 262, 180, 32, 'Cancelar', COLOR.peligro, cancelar));
    } else if (ocupado) {
        // Mientras escanea, el equipo espera respuesta: otra hoja o se acabó.
        w.push(boton('otra', 24, 186, 200, 54, 'Otra página', COLOR.acento, () => seguir(true)));
        w.push(boton('terminar', 244, 186, 200, 54, 'TERMINAR', COLOR.ok, () => seguir(false)));
        w.push(etiqueta('msg', 12, 248, 456, 30, recortar(mensaje, 62), colorMensaje));
        w.push(boton('cancelar', 24, 282, 180, 32, 'Cancelar', COLOR.peligro, cancelar));
    } else {
        w.push(boton('escanear', 140, 186, 200, 54, 'ESCANEAR', COLOR.ok, escanear));
        w.push(etiqueta('msg', 12, 256, 456, 44, recortar(mensaje, 62), colorMensaje));
    }
    return w;
}

/**
 * Abre la pantalla para `usuario`. Los destinos se calculan aquí: cada persona ve los
 * suyos, y al abrir se empieza de cero (la impresora es de todos).
 */
export function abrirEscaneo(usuario, volver) {
    alVolver = volver;
    quien = usuario || '';
    if (estado === 'listo') {
        destinos = destinosDe(quien);
        iDestino = 0;
        iFormato = 0;
        decir('', COLOR.suave);
    }
    mostrar('escaneo', render);
}
