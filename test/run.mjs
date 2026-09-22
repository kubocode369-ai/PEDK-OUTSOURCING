/**
 * Pruebas contra un `pedk` simulado:   npm test
 *
 * No sustituyen a la prueba en el equipo (ver Diagnóstico > Probar cerradura), pero
 * cada camino —incluido el recorrido completo por el panel— se ejecuta de verdad.
 *
 * Los módulos de src/ se copian a .build/ como .mjs porque el paquete no es "module"
 * (cambiarlo afectaría a vite y a pedk-build). Se importan UNA vez y entre casos se
 * cambia `globalThis.pedk`: los módulos leen `pedk` en cada llamada.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const aqui = dirname(fileURLToPath(import.meta.url));
const build = join(aqui, '.build');
mkdirSync(build, { recursive: true });
for (const f of readdirSync(join(aqui, '..', 'src'))) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(aqui, '..', 'src', f), 'utf8').replace(/from '\.\/([a-zA-Z]+)\.js'/g, "from './$1.mjs'");
    writeFileSync(join(build, basename(f, '.js') + '.mjs'), src);
}

const { makePedk } = await import('./mock-pedk.mjs');

let ok = 0;
let fallos = 0;
function check(nombre, cond, detalle) {
    if (cond) {
        ok++;
        console.log('  OK    ' + nombre);
    } else {
        fallos++;
        console.log('  FALLA ' + nombre + (detalle !== undefined ? ' -> ' + detalle : ''));
    }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Silenciar la consola de la app; se muestra sólo si algo falla.
const logOriginal = console.log;
const consola = [];
function silenciar() { console.log = (...a) => consola.push(a.join(' ')); }
function hablar() { console.log = logOriginal; }

let mock = makePedk();
globalThis.pedk = mock.pedk;
const store = await import('./.build/store.mjs');
const cerradura = await import('./.build/cerradura.mjs');
const historial = await import('./.build/historial.mjs');
const sesion = await import('./.build/sesion.mjs');
const retencion = await import('./.build/retencion.mjs');
const vigia = await import('./.build/vigia.mjs');
const { config } = await import('./.build/config.mjs');

/** Equipo nuevo y memoria vacía. */
function equipo(opts) {
    mock = makePedk(opts);
    globalThis.pedk = mock.pedk;
    store._recargar();
    sesion._reiniciar();
    retencion._reiniciar();
    return mock;
}

logOriginal('\n=== Impresión con PIN · pruebas ===\n');
silenciar();

/* ------------------------------------------------------------------ */
hablar(); console.log('· Usuarios y PIN'); silenciar();
{
    equipo();
    hablar();
    check('alta de usuario', store.agregarUsuario('Ana', '4321').ok);
    check('el nombre se guarda en minúsculas', store.usuarios()[0].nombre === 'ana');
    check('no admite repetidos', !store.agregarUsuario('ana', '1111').ok);
    check('rechaza PIN corto', !store.agregarUsuario('beto', '12').ok);
    check('rechaza PIN con letras', !store.agregarUsuario('beto', '12ab').ok);
    check('rechaza nombres con espacios', !store.agregarUsuario('juan perez', '1234').ok);
    check('el PIN no se guarda en claro', JSON.stringify(mock.getStore()).indexOf('4321') < 0);
    check('usuario y PIN correctos entran', store.validarUsuario('ANA', '4321').ok);
    const malo = store.validarUsuario('ana', '0000');
    check('PIN malo no entra', !malo.ok && /incorrecto/.test(malo.error), malo.error);
    check('usuario inexistente da el mismo mensaje',
        store.validarUsuario('nadie', '4321').error === malo.error);

    const t0 = 1000000;
    for (let i = 0; i < config.INTENTOS_MAX; i++) store.validarUsuario('ana', '0000', t0);
    const bloqueado = store.validarUsuario('ana', '4321', t0 + 1000);
    check('tras ' + config.INTENTOS_MAX + ' fallos bloquea aunque el PIN sea bueno', !bloqueado.ok && /intentos/.test(bloqueado.error), bloqueado.error);
    check('el bloqueo por intentos caduca',
        store.validarUsuario('ana', '4321', t0 + config.BLOQUEO_INTENTOS_MS + 1).ok);

    store.activarUsuario('ana', false);
    check('usuario desactivado no entra', !store.validarUsuario('ana', '4321').ok);
    store.activarUsuario('ana', true);

    check('PIN de admin de fábrica vale', store.esPinAdmin(config.PIN_ADMIN_FABRICA));
    store.cambiarPinAdmin('97531');
    check('tras cambiarlo, el de fábrica ya no vale', !store.esPinAdmin(config.PIN_ADMIN_FABRICA) && store.esPinAdmin('97531'));

    store._recargar();
    check('todo sobrevive a releer la memoria', store.usuarios().length === 1 && store.esPinAdmin('97531'));
    const ajena = makePedk({ store: { otraApp: { x: 1 } } });
    globalThis.pedk = ajena.pedk;
    store._recargar();
    store.agregarUsuario('luis', '1234');
    check('respeta los datos de otras claves de la memoria', ajena.getStore().otraApp && ajena.getStore().otraApp.x === 1);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Restaurar usuarios (lo que usa la copia de seguridad)'); silenciar();
{
    equipo();
    store.agregarUsuario('ana', '1234');
    hablar();
    const r = store.restaurarUsuarios({ usuarios: [
        { nombre: 'luis', pin: '4321' },
        { nombre: 'MARIA', pin: '1111' },
        { nombre: 'ana', pin: '9999' },
        { nombre: 'no valido!', pin: '1234' },
        { nombre: 'sinpin' },
        { nombre: 'pepe', huella: 'abc', activo: false },
    ] });
    check('da de alta a los nuevos y normaliza el nombre', store.usuarios().some((u) => u.nombre === 'luis')
        && store.usuarios().some((u) => u.nombre === 'maria'), JSON.stringify(store.usuarios().map((u) => u.nombre)));
    check('el PIN restaurado funciona', store.validarUsuario('luis', '4321').ok);
    check('actualiza el PIN de quien ya existía', store.validarUsuario('ana', '9999').ok && !store.validarUsuario('ana', '1234').ok);
    check('cuenta los mal escritos y no los da de alta', r.malos === 2 && r.creados === 3, JSON.stringify(r));
    check('restaura con la huella y respeta el desactivado', store.usuarios().filter((u) => u.nombre === 'pepe')[0].huella === 'abc'
        && store.usuarios().filter((u) => u.nombre === 'pepe')[0].activo === false);
    store.restaurarUsuarios({ usuarios: [{ nombre: 'otro', pin: '5555' }] });
    check('NO borra a nadie que no venga en el fichero', store.usuarios().length === 5, JSON.stringify(store.usuarios().map((u) => u.nombre)));
    check('un fichero sin lista de usuarios se rechaza sin romper', !store.restaurarUsuarios('no soy json').ok
        && !store.restaurarUsuarios({ usuarios: 'x' }).ok && store.usuarios().length === 5);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Los datos sobreviven a un reinicio'); silenciar();
{
    // La prueba que faltaba desde el principio. El equipo devuelve un STRING en
    // getUserDefinedData (medido), no un objeto: eso hacía que la app no pudiera
    // releer nunca sus propios datos y arrancara siempre con cero usuarios.
    // "Reiniciar" aquí es _recargar() sin tocar lo que el equipo tiene guardado.
    const m = makePedk();
    globalThis.pedk = m.pedk;
    store._recargar();
    store.agregarUsuario('ana', '1234');
    store.cambiarPinAdmin('9876');
    store.contar('ana', { tipo: 'PRINT', paginas: 4 });

    store._recargar();                       // ← apagar y encender
    hablar();
    check('tras reiniciar, ana sigue ahí', store.usuarios().length === 1 && store.usuarios()[0].nombre === 'ana',
        JSON.stringify(store.usuarios()));
    check('tras reiniciar, su PIN sigue valiendo', store.validarUsuario('ana', '1234').ok);
    check('tras reiniciar, el PIN de admin cambiado sigue valiendo',
        store.esPinAdmin('9876') && !store.esPinAdmin(config.PIN_ADMIN_FABRICA));
    check('tras reiniciar, los contadores siguen ahí', store.contadorDe('ana').paginas === 4,
        JSON.stringify(store.contadorDe('ana')));
    check('se guardó en los dos sitios', Object.keys(m.getFicheros()).length === 2
        && !!m.getStore().impresionPin, Object.keys(m.getFicheros()).join(','));
    silenciar();

    // La memoria del equipo tiene un TOPE y devuelve el JSON cortado a medias (medido
    // el 18-09-2026). No puede costar los datos: el fichero es quien manda, y a la
    // memoria se le manda sólo lo pequeño y precioso, sin registro ni vistos.
    const tope = makePedk({ uddTope: 120 });
    globalThis.pedk = tope.pedk;
    store._recargar();
    store.agregarUsuario('ana', '1234');
    for (let i = 0; i < 40; i++) store.contar('ana', { tipo: 'PRINT', paginas: 1, doc: 'documento-largo-' + i });
    store._recargar();
    hablar();
    check('con la memoria cortada, los datos siguen ahí (manda el fichero)',
        store.usuarios().length === 1 && store.contadorDe('ana').paginas === 40,
        JSON.stringify(store.contadorDe('ana')));
    check('a la memoria no se le manda el registro ni los vistos', (() => {
        const d = tope.getStore().impresionPin;
        return !!d && d.usuarios.length === 1 && d.registro === undefined && d.vistos === undefined;
    })(), JSON.stringify(Object.keys(tope.getStore().impresionPin || {})));
    silenciar();
    // Object.save/load son globales y se los llevó `tope`: hay que devolverlos.
    globalThis.pedk = m.pedk;
    m.activar();
    store._recargar();

    // Si se pierde un sitio, el otro salva los datos. Los dos casos.
    m.borrarFicheros();
    store._recargar();
    hablar();
    check('sin los ficheros, los recupera de setUserDefinedData', store.usuarios().length === 1);
    silenciar();
    store.agregarUsuario('luis', '4321');    // vuelve a poblar el fichero
    const soloFichero = makePedk({ ficheros: m.getFicheros() });
    globalThis.pedk = soloFichero.pedk;      // equipo con los ficheros pero sin memoria
    store._recargar();
    hablar();
    check('sin setUserDefinedData, los recupera del fichero', store.usuarios().length === 2,
        JSON.stringify(store.usuarios().map((u) => u.nombre)));
    silenciar();

    // Y si el equipo devuelve un objeto, como promete la doc, también vale.
    const doc = makePedk({ uddObjeto: true, sinObjectSave: true });
    globalThis.pedk = doc.pedk;
    store._recargar();
    store.agregarUsuario('ana', '1234');
    store._recargar();
    hablar();
    check('aguanta también la forma que promete la doc (objeto)', store.usuarios().length === 1,
        JSON.stringify(store.usuarios()));
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Memoria que no se deja leer (no debe borrar nada)'); silenciar();
{
    // Este es el fallo que perdía a los usuarios al reiniciar la impresora: si la
    // lectura falla al arrancar, el cache queda vacío y el primer guardado —que llega
    // a los milisegundos, desde historial.vigilar— escribía ese vacío encima.
    for (const modo of ['lanza', 'error']) {
        const previo = { impresionPin: { version: 1, usuarios: [{ nombre: 'ana', huella: 'x', activo: true }], contadores: { ana: { impresiones: 3, paginas: 7, copias: 0, paginasCopia: 0 } }, registro: [], vistos: [], historialIniciado: true, ajustes: {} } };
        const m = makePedk({ store: previo, memoriaFalla: modo });
        globalThis.pedk = m.pedk;
        store._recargar();
        hablar();
        // La lectura es perezosa: ocurre en el primer acceso, no al importar el módulo.
        check('memoria ' + modo + ': no ve usuarios (no puede leerlos)', store.usuarios().length === 0);
        check('memoria ' + modo + ': queda en sólo lectura', store.estado().soloLectura, JSON.stringify(store.estado()));
        silenciar();
        // Lo que hacía el arranque: marcar el historial y contar. No debe grabar.
        store.marcarVistos(['1|x'], true);
        store.contar('ana', { tipo: 'PRINT', paginas: 2 });
        hablar();
        check('memoria ' + modo + ': NO pisa a los usuarios guardados',
            m.getStore().impresionPin.usuarios.length === 1, JSON.stringify(m.getStore().impresionPin.usuarios));
        check('memoria ' + modo + ': NO pisa los contadores guardados',
            m.getStore().impresionPin.contadores.ana.paginas === 7, JSON.stringify(m.getStore().impresionPin.contadores));
        silenciar();
        // El equipo despierta: a partir de aquí se recuperan los datos y se guarda.
        m.memoriaResponde();
        const esperar15s = Date.now;
        Date.now = () => esperar15s() + 20000;
        const us = store.usuarios();
        Date.now = esperar15s;
        hablar();
        check('memoria ' + modo + ': al responder recupera a ana', us.length === 1 && us[0].nombre === 'ana', JSON.stringify(us));
        check('memoria ' + modo + ': y sale de sólo lectura', !store.estado().soloLectura);
        silenciar();
        store.agregarUsuario('luis', '4321');
        hablar();
        check('memoria ' + modo + ': ya vuelve a guardar', m.getStore().impresionPin.usuarios.length === 2,
            JSON.stringify(m.getStore().impresionPin.usuarios.map((u) => u.nombre)));
        silenciar();
    }
    // Un equipo de verdad vacío SÍ debe poder guardar: no es un fallo de lectura.
    const nuevo = makePedk();
    globalThis.pedk = nuevo.pedk;
    store._recargar();
    store.agregarUsuario('ana', '1234');
    hablar();
    check('equipo nuevo (memoria vacía) sí guarda', !store.estado().soloLectura
        && nuevo.getStore().impresionPin.usuarios.length === 1);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Cerradura'); silenciar();
{
    equipo();
    const r = cerradura.cerrar({ impresion: true, copia: false });
    hablar();
    check('bloquear apaga red y USB', r.ok && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF'
        && mock.switches.FUNC_T_USBPORT_PRINT === 'FUNC_SW_OFF', JSON.stringify(mock.switches));
    check('sin pedirlo, no toca la copia', mock.switches.FUNC_T_COPY === 'FUNC_SW_ON');
    check('lee el estado bloqueado', cerradura.impresionBloqueada() === true);
    silenciar();
    const a = cerradura.abrir();
    hablar();
    check('desbloquear enciende todo', a.ok && Object.values(mock.switches).every((v) => v === 'FUNC_SW_ON'));
    silenciar();

    equipo({ ignora: ['FUNC_T_NET_PRINT'] });
    const r2 = cerradura.cerrar({ impresion: true });
    hablar();
    check('si el equipo acepta la orden y no cambia nada, NO se da por bloqueado', r2.ok === false, r2.resumen);
    check('y el resumen dice cuál falló', /NET_PRINT/.test(r2.resumen), r2.resumen);
    silenciar();

    equipo({ rechaza: ['FUNC_T_NET_PRINT'] });
    let lanzo = false;
    let r3;
    try { r3 = cerradura.cerrar({ impresion: true }); } catch (e) { lanzo = true; }
    hablar();
    check('un EOPNOTSUPP del firmware no revienta la app', !lanzo && r3.ok === false);
    silenciar();

    equipo({ exportados: ['FUNC_T_USBPORT_PRINT', 'FUNC_T_COPY'] });
    const r4 = cerradura.cerrar({ impresion: true });
    hablar();
    check('firmware sin NET_PRINT: no se da por bloqueado', r4.ok === false && cerradura.impresionBloqueada() === null);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Historial'); silenciar();
{
    equipo({ historialPrevio: [{ paginas: 5 }, { paginas: 2 }] });
    const vistos = [];
    const n0 = historial.revisar((e) => vistos.push(e));
    hablar();
    check('la primera lectura no cuenta lo que ya había', n0 === 0 && vistos.length === 0);
    silenciar();

    mock.imprimir({ tipo: 'PRINT', paginas: 3 });
    mock.imprimir({ tipo: 'COPY', paginas: 2 });
    mock.imprimir({ tipo: 'SCAN', paginas: 4 });
    const n1 = historial.revisar((e) => vistos.push(e));
    const n2 = historial.revisar((e) => vistos.push(e));
    hablar();
    check('entrega impresión y copia, no el escaneo', n1 === 2 && vistos.map((v) => v.tipo).join() === 'PRINT,COPY', JSON.stringify(vistos));
    check('lleva las páginas del equipo', vistos[0].paginas === 3 && vistos[1].paginas === 2);
    check('no entrega dos veces lo mismo', n2 === 0);
    store._recargar();
    check('lo contado se recuerda tras reiniciar la app', historial.revisar(() => {}) === 0);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Sesión y atribución'); silenciar();
{
    equipo();
    store.agregarUsuario('ana', '4321');
    store.cambiarAjuste('bloqueoActivo', true);
    sesion.reposo();
    const t = 5000000;
    const r = sesion.abrir('ana', '4321', t);
    hablar();
    check('abrir sesión desbloquea', r.ok && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON');
    check('con sesión, el trabajo es de quien entró', sesion.quienUsa(t + 1000) === 'ana');
    check('la sesión vence por inactividad',
        !sesion.vencida(t + 1000) && sesion.vencida(t + store.ajustes().minutosSesion * 60000 + 1));
    silenciar();
    const c = sesion.cerrar('boton', t + 2000);
    hablar();
    check('cerrar vuelve a bloquear', c.ok && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF');
    check('durante la gracia sigue siendo suyo', sesion.quienUsa(t + 2000 + config.GRACIA_MS - 1) === 'ana');
    check('pasada la gracia va a "sin sesión"', sesion.quienUsa(t + 2000 + config.GRACIA_MS + 1) === store.SIN_SESION);
    silenciar();

    equipo({ ignora: ['FUNC_T_NET_PRINT'] });
    store.agregarUsuario('ana', '4321');
    store.cambiarAjuste('bloqueoActivo', true);
    mock.switches.FUNC_T_NET_PRINT = 'FUNC_SW_OFF';
    const r2 = sesion.abrir('ana', '4321');
    hablar();
    check('si el equipo no se desbloquea, la sesión no se abre', !r2.ok && !sesion.activa(), r2.error);
    silenciar();

    equipo();
    mock.switches.FUNC_T_NET_PRINT = 'FUNC_SW_OFF';
    mock.switches.FUNC_T_COPY = 'FUNC_SW_OFF';
    const rep = sesion.reposo();
    hablar();
    check('con el bloqueo apagado (p. ej. tras reinstalar), el arranque desbloquea lo que quedó',
        rep.ok && Object.values(mock.switches).every((v) => v === 'FUNC_SW_ON'), JSON.stringify(mock.switches));
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Cambiar de modo no puede dejar la impresora sorda'); silenciar();
{
    // Lo que pasó en el equipo el 18-09-2026: con el bloqueo puesto en modo SESIÓN se
    // apaga NET_PRINT; al pasar a RETENCIÓN nadie lo volvía a encender, y NET_PRINT
    // apagado mata también la impresión segura. La primera tanda de documentos (la que
    // ya estaba retenida) salía bien, pero los siguientes NO LLEGABAN a la impresora:
    // la lista salía vacía y parecía un fallo de la retención.
    const m = equipo();
    store.agregarUsuario('ana', '1234');
    store.cambiarAjuste('bloqueoActivo', true);

    store.cambiarAjuste('modo', 'sesion');
    sesion.reposo();
    hablar();
    check('modo sesión + bloqueo apaga la impresión de red', m.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF',
        m.switches.FUNC_T_NET_PRINT);
    silenciar();

    store.cambiarAjuste('modo', 'retencion');
    sesion.reposo();
    hablar();
    check('al pasar a retención, la impresión de red se vuelve a ENCENDER',
        m.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON', m.switches.FUNC_T_NET_PRINT);
    check('y la impresión segura sigue encendida', m.switches.FUNC_T_SECURE_PRINT === 'FUNC_SW_ON',
        m.switches.FUNC_T_SECURE_PRINT);
    silenciar();

    // Y al revés: volver a modo sesión tiene que apagarla otra vez.
    store.cambiarAjuste('modo', 'sesion');
    sesion.reposo();
    hablar();
    check('volver a modo sesión la apaga de nuevo', m.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF',
        m.switches.FUNC_T_NET_PRINT);
    silenciar();

    // La copia sigue la misma regla: dejar de bloquearla tiene que reabrirla.
    store.cambiarAjuste('bloquearCopia', true);
    sesion.reposo();
    const copiaCerrada = m.switches.FUNC_T_COPY === 'FUNC_SW_OFF';
    store.cambiarAjuste('bloquearCopia', false);
    sesion.reposo();
    hablar();
    check('dejar de bloquear la copia la reabre', copiaCerrada && m.switches.FUNC_T_COPY === 'FUNC_SW_ON',
        copiaCerrada + ' / ' + m.switches.FUNC_T_COPY);
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Retención'); silenciar();
{
    // Forma medida el 16-09-2026: el dueño es el usuario de Windows y cada trabajo lleva
    // el Nombre del driver numerado. Dos personas comparten la cuenta "KuboC".
    equipo({ retencion: {
        KuboC: [{ doc: 'Ana', pin: '4321' }, { doc: 'beto', pin: '5555' }, { doc: 'ana_1', pin: '4321' }],
        Sala: [{ doc: 'ana_2', pin: '4321' }],
    } });
    hablar();
    const d = retencion.disponible();
    check('esquiva la trampa de setJobId del firmware', d.ok && /sin trampa/.test(d.detalle), d.detalle);
    check('lee los dueños que da el equipo como texto', retencion.nombresConTrabajos().join() === 'KuboC,Sala', retencion.nombresConTrabajos().join());
    check('parsea la lista con corchetes y comillas', retencion.parsearLista('["a.pdf","b c.doc"]').join('|') === 'a.pdf|b c.doc');
    check('reconoce los nombres numerados del equipo', retencion.esDe('ana_1', 'ana') && retencion.esDe('ANA', 'ana')
        && !retencion.esDe('anabel', 'ana') && !retencion.esDe('ana_x', 'ana'));
    const j = retencion.trabajosDe('ana', '4321');
    check('reúne los documentos de la persona desde cualquier cuenta de Windows',
        j.map((x) => x.doc + '@' + x.dueno).join() === 'Ana@KuboC,ana_1@KuboC,ana_2@Sala', JSON.stringify(j));
    check('no muestra los de otra persona de la misma cuenta', !j.some((x) => x.doc === 'beto'));
    check('con otro PIN no abre nada', retencion.trabajosDe('ana', '1111').length === 0);
    check('sin consultar antes no libera', !retencion.liberar(0).ok);
    retencion.trabajosDe('ana', '4321');
    const lib = retencion.liberar(1);
    check('el resultado basura del firmware cuenta como éxito', lib.ok && mock.liberados.join() === 'ana_1', JSON.stringify(lib));
    check('y se comprueba que ya no está retenido', retencion.sigueRetenido() === false);
    check('tras liberar hay que volver a consultar', !retencion.liberar(0).ok);
    check('la lista ya no trae el impreso', retencion.trabajosDe('ana', '4321').map((x) => x.doc).join() === 'Ana,ana_2');
    silenciar();

    equipo({ retencion: { KuboC: [{ doc: 'x', pin: '4321' }] } });
    const EJP = mock.pedk.jobs.print.EncryptJobPrint;
    delete EJP.prototype.start;
    hablar();
    retencion.trabajosDe('x', '4321');
    check('sin start() oficial, libera con la función nativa', retencion.liberar(0).ok && mock.liberados.join() === 'x', mock.liberados.join());
    silenciar();

    equipo({ retencion: {}, retencionRota: true });
    hablar();
    const rota = retencion.disponible();
    check('si registrar el trabajo falla, aún prueba con la base nativa', rota.ok && /base/.test(rota.detalle), rota.detalle);
    equipo();
    check('sin EncryptJobPrint, no se ofrece', !retencion.disponible().ok);
    silenciar();

    const explorar = await import('./.build/explorar.mjs');
    equipo({ retencion: {}, retencionRota: true });
    const inicio = consola.length;
    const resumen = explorar.volcar();
    const volcado = consola.slice(inicio);
    hablar();
    check('explorar lee la fuente de EncryptJobPrint', volcado.some((l) => /EncryptJobPrint\.fuente( 1\/\d+)?: class/.test(l)), volcado.slice(0, 5).join('\n'));
    check('y anota por qué falla el constructor', resumen.some((l) => /EXIT_FAILURE/.test(l)), resumen.join(' | '));
    check('trocea las líneas largas del log', volcado.every((l) => l.length < 900));
    silenciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Historial de más de 200 trabajos: nada se cuenta dos veces'); silenciar();
{
    // Visto en el equipo el 22-09-2026: con más de VISTOS_MAX trabajos en el historial, la
    // lista de ya contados "olvidaba" los viejos, reaparecían, echaban a los recientes y
    // éstos se volvían a contar (una impresión de 2 páginas salió 4 veces).
    const previos = [];
    for (let i = 0; i < 260; i++) previos.push({ tipo: i % 2 ? 'PRINT' : 'COPY', paginas: 1 });
    equipo({ historialPrevio: previos });
    const contados = [];
    historial.revisar((e) => contados.push(e));
    hablar();
    check('la primera lectura no cuenta los 260 trabajos previos', contados.length === 0);
    mock.imprimir({ tipo: 'PRINT', paginas: 2 });
    for (let i = 0; i < 30; i++) historial.revisar((e) => contados.push(e));
    mock.imprimir({ tipo: 'COPY', paginas: 1 });
    for (let i = 0; i < 30; i++) historial.revisar((e) => contados.push(e));
    check('en 60 lecturas cada trabajo nuevo se cuenta UNA vez', contados.length === 2
        && contados[0].paginas === 2 && contados[1].tipo === 'COPY', contados.map((e) => e.id).join(','));
    for (let i = 0; i < 400; i++) mock.imprimir({ tipo: 'PRINT', paginas: 1 });
    contados.length = 0;
    for (let i = 0; i < 5; i++) historial.revisar((e) => contados.push(e));
    check('con 400 trabajos de golpe, cada uno una vez', contados.length === 400
        && new Set(contados.map((e) => e.id)).size === 400, contados.length);
    // El estado que dejó el fallo en el equipo: 200 claves revueltas y sin suelo.
    const d = mock.getStore();
    check('la lista de ya contados no crece sin límite', store.estado && JSON.stringify(d).length < 200000);
    silenciar();
}

hablar(); console.log('· Vigía de trabajos'); silenciar();
{
    equipo();
    vigia._reiniciar();
    const escucha = vigia.iniciar();
    mock.llegaTrabajo({ id: 21, tipo: 'PRINT_NET', estado: 'JBSts_Running', usuario: 'KuboC', doc: 'hola.txt' });
    mock.llegaTrabajo({ id: 21, tipo: 'PRINT_NET', estado: 'JBSts_Running', usuario: 'KuboC', doc: 'hola.txt' });
    hablar();
    check('se registra como oyente de trabajos', escucha === true);
    const ev = vigia.ultimosEventos();
    check('anota tipo, estado y usuario del trabajo', ev.length === 1 && ev[0].tipo === 'PRINT_NET'
        && ev[0].usuario === 'KuboC', JSON.stringify(ev));
    silenciar();

    mock.llegaTrabajo({ id: 21, tipo: 'PRINT_NET', estado: 'JBSts_Finish' });
    vigia.armarCancelacion();
    mock.llegaTrabajo({ id: 21, tipo: 'PRINT_NET', estado: 'JBSts_Finish' });
    mock.llegaTrabajo({ id: 22, tipo: 'SCAN_TO_PC', estado: 'JBSts_Running' });
    hablar();
    check('un cambio de estado se anota como evento nuevo', vigia.ultimosEventos().length === 3, JSON.stringify(vigia.ultimosEventos()));
    check('armada, no cancela trabajos ya vistos ni escaneos', mock.cancelados.length === 0 && vigia.estadoCancelacion() === 'armada');
    silenciar();

    mock.llegaTrabajo({ id: 23, tipo: 'PRINT_NET', estado: 'JBSts_Ready' });
    mock.llegaTrabajo({ id: 24, tipo: 'PRINT_NET', estado: 'JBSts_Ready' });
    hablar();
    check('cancela la primera impresión nueva y se desarma', mock.cancelados.join() === '23', mock.cancelados.join());
    check('deja anotado el resultado', /#23 .*cancelJob=true/.test(vigia.estadoCancelacion()), vigia.estadoCancelacion());
    check('la lista se lee a pedido (el cancelado ya no está)', vigia.leerLista() === 3);
    silenciar();

    vigia.armarCancelacion(0);
    hablar();
    check('la cancelación armada caduca', vigia.estadoCancelacion() !== 'armada');
    silenciar();

    const sinJobs = makePedk();
    delete sinJobs.pedk.jobctl.addJobListener;
    globalThis.pedk = sinJobs.pedk;
    vigia._reiniciar();
    hablar();
    check('sin addJobListener no revienta y lo dice', vigia.iniciar() === false && /escucha no/.test(vigia.informe()[0]), vigia.informe()[0]);
    silenciar();

    // En el equipo el aviso dice "PRINT"; quizá la lista dé el tipo fino, y se anota aparte.
    equipo();
    vigia._reiniciar();
    vigia.iniciar();
    let lecturas = 0;
    const listaOriginal = mock.pedk.jobctl.getJobList;
    mock.pedk.jobctl.getJobList = () => {
        lecturas++;
        return listaOriginal().map((i) => ({ ...i, getJobType: () => 'PRINT_ENCRYPT' }));
    };
    mock.llegaTrabajo({ id: 30, tipo: 'PRINT', estado: 'JBSts_Ready' });
    mock.llegaTrabajo({ id: 30, tipo: 'PRINT', estado: 'JBSts_Running' });
    hablar();
    check('un trabajo nuevo lee la lista una sola vez', lecturas === 1, lecturas);
    check('y anota el tipo fino que dé la lista',
        vigia.ultimosEventos().some((x) => x.id === '30' && x.origen === 'lista' && x.tipo === 'PRINT_ENCRYPT'),
        JSON.stringify(vigia.ultimosEventos()));
    silenciar();
    vigia._reiniciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Guardián: sólo se imprime con usuario y PIN'); silenciar();
{
    equipo();
    vigia._reiniciar();
    vigia.iniciar();
    // Política igual que app.js: en retención con bloqueo, cancela lo normal.
    const citado = (doc) => { const s = String(doc || ''); return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"'; };
    let ventana = false;
    vigia.guardian((e) => {
        if (String(e.tipo).indexOf('PRINT') < 0) return 'ignorar';
        if (citado(e.doc)) return 'permitir';
        if (ventana) return 'permitir';
        return 'cancelar';
    });

    mock.llegaTrabajo({ id: 1, wo: 0, tipo: 'PRINT', estado: 'JBSts_Ready', doc: '"t"' });   // seguro guardándose
    mock.llegaTrabajo({ id: 2, wo: 5, tipo: 'COPY', estado: 'JBSts_Running' });               // copia
    hablar();
    check('deja pasar el seguro que se está guardando', !mock.cancelados.includes(1));
    check('no toca las copias', !mock.cancelados.includes(2));
    silenciar();

    mock.llegaTrabajo({ id: 3, wo: 9, tipo: 'PRINT', estado: 'JBSts_Ready', doc: 'Documento sin PIN.docx' });
    hablar();
    check('cancela la impresión normal en cuanto llega', mock.cancelados.includes(3));
    silenciar();

    mock.cancelados.length = 0;
    ventana = true;   // la app acaba de liberar un documento
    mock.llegaTrabajo({ id: 4, wo: 1, tipo: 'PRINT', estado: 'JBSts_Ready', doc: 't' });
    hablar();
    check('deja pasar el documento liberado por la app', !mock.cancelados.includes(4));
    silenciar();
    vigia._reiniciar();
}

/* ------------------------------------------------------------------ */
hablar(); console.log('· Recorrido completo por el panel (modo sesión)'); silenciar();
{
    historial.detener();
    equipo({ historialPrevio: [{ paginas: 5 }, { paginas: 2 }] });
    const teclear = (texto) => texto.split('').forEach((c) => mock.pulsar(c));

    await import('./.build/app.mjs');
    hablar();
    check('arranca y dibuja el inicio', /Impresión con PIN/.test(mock.textos()), mock.textos());
    check('de fábrica el bloqueo está apagado y lo dice', /Bloqueo apagado/.test(mock.textos()));
    check('de fábrica no toca los interruptores', mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON');
    silenciar();

    // Se pasa por el login ANTES de ir a Ajustes, como hizo la persona en el equipo
    // (Pedk1.log, 17-09-2026). Importa el orden: el equipo no olvida los listeners, y
    // el primero registrado con un id gana para siempre. Si la pantalla de "Su
    // usuario" y la de "Nuevo usuario" comparten ids, a partir de aquí el Siguiente de
    // Ajustes ejecuta el del login y no se puede dar de alta a nadie.
    mock.pulsar('entrar');
    hablar();
    check('Entrar pide el usuario', /Su usuario/.test(mock.textos()), mock.textos());
    silenciar();
    const idsLogin = mock.botones();
    mock.pulsar('cancelar');

    mock.pulsar('ajustes');
    teclear(config.PIN_ADMIN_FABRICA);
    mock.pulsar('OK');
    hablar();
    check('entra a Ajustes con el PIN de fábrica', /Ajustes/.test(mock.textos()) && /Usuarios/.test(mock.textos()), mock.textos());
    silenciar();

    mock.pulsar('bloqueo');
    hablar();
    check('no deja bloquear sin usuarios', /al menos un usuario/.test(mock.textos()) && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON');
    silenciar();

    mock.pulsar('usuarios');
    mock.pulsar('nuevo');
    hablar();
    check('ninguna pantalla comparte ids con el login',
        mock.botones().filter((id) => idsLogin.indexOf(id) >= 0).length === 0,
        mock.botones().filter((id) => idsLogin.indexOf(id) >= 0).join(','));
    silenciar();
    teclear('ana');
    mock.pulsar('seguir');
    hablar();
    check('Siguiente pasa del nombre al PIN', /dígitos/.test(mock.textos()), mock.textos());
    silenciar();
    teclear('4321'); mock.pulsar('OK');
    teclear('4321'); mock.pulsar('OK');
    hablar();
    check('crea el usuario desde el panel', store.usuarios().some((u) => u.nombre === 'ana'), mock.textos());
    silenciar();

    mock.pulsar('volver');
    mock.pulsar('bloqueo');
    hablar();
    check('encender el bloqueo apaga la impresión de red y USB',
        mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF' && mock.switches.FUNC_T_USBPORT_PRINT === 'FUNC_SW_OFF');
    silenciar();

    mock.pulsar('salir');
    hablar();
    check('el inicio dice que está bloqueado', /Equipo bloqueado/.test(mock.textos()), mock.textos());
    silenciar();

    mock.pulsar('entrar');
    teclear('ana');
    mock.pulsar('seguir');
    teclear('9999'); mock.pulsar('OK');
    hablar();
    check('PIN malo: no entra y sigue bloqueado', /incorrecto/.test(mock.textos()) && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF');
    silenciar();

    teclear('4321'); mock.pulsar('OK');
    hablar();
    check('PIN bueno: abre sesión y desbloquea', /Hola, ana/.test(mock.textos()) && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON', mock.textos());
    silenciar();

    mock.imprimir({ tipo: 'PRINT', paginas: 3 });
    await esperar(config.HISTORIAL_CON_SESION_MS + 700);
    hablar();
    const c = store.contadorDe('ana');
    check('la impresión se le cuenta a ana', c.impresiones === 1 && c.paginas === 3, JSON.stringify(c));
    check('lo impreso antes de instalar no se le cuenta a nadie', store.contadores().length === 1, JSON.stringify(store.contadores()));
    check('la pantalla de la sesión lo muestra', /1 impresión\(es\), 3 pág\./.test(mock.textos()), mock.textos());
    silenciar();

    // El registro del equipo puede aflorar trabajos viejos (número más bajo): no se cuentan.
    mock.imprimir({ tipo: 'PRINT', paginas: 9, id: 5 });
    await esperar(config.HISTORIAL_CON_SESION_MS + 700);
    hablar();
    check('no cuenta trabajos viejos que afloran al activar el registro', store.contadorDe('ana').paginas === 3, JSON.stringify(store.contadorDe('ana')));
    silenciar();

    mock.imprimir({ tipo: 'PRINT', paginas: 2 });
    mock.pulsar('terminar');
    hablar();
    check('lo que ya terminó al pulsar Terminar se cuenta sin esperar', store.contadorDe('ana').paginas === 5, JSON.stringify(store.contadorDe('ana')));
    check('Terminar vuelve a bloquear', mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_OFF');
    check('y vuelve al inicio', /Hasta luego, ana/.test(mock.textos()), mock.textos());
    silenciar();

    mock.pulsar('ajustes');
    teclear(config.PIN_ADMIN_FABRICA); mock.pulsar('OK');
    mock.pulsar('contadores');
    hablar();
    check('Ajustes > Contadores muestra lo de ana', /ana/.test(mock.textos()) && /2 imp\. 5 pág\./.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('volver');
    mock.pulsar('diag');
    hablar();
    check('el diagnóstico se dibuja y lee los interruptores', /NET_PRINT: FUNC_SW_OFF/.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('trabajos');
    mock.llegaTrabajo({ id: 90, tipo: 'PRINT_NET', estado: 'JBSts_Running', usuario: 'ric' });
    hablar();
    check('la pantalla Trabajos muestra lo que llega', /Trabajos que llegan/.test(mock.textos()) && /#90 PRINT_NET Running 0\/0p ric/.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('cancelar');
    mock.llegaTrabajo({ id: 91, tipo: 'PRINT_NET', estado: 'JBSts_Ready' });
    hablar();
    check('desde el panel se prueba la cancelación', mock.cancelados.includes(91) && /Cancelación: #91/.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('volver');
    hablar();
    check('Volver regresa al diagnóstico', /Diagnóstico del equipo/.test(mock.textos()), mock.textos());
    silenciar();
    const antesExplorar = consola.length;
    mock.pulsar('explorar');
    hablar();
    check('Explorar SDK resume en el panel', /Globales: \d+/.test(mock.textos()) && /EncryptJobPrint: undefined/.test(mock.textos()), mock.textos());
    check('y vuelca el detalle al log', consola.slice(antesExplorar).some((l) => /^\[explorar\] pedk: /.test(l)));
    silenciar();
    mock.pulsar('volver');
    mock.pulsar('abrir');
    hablar();
    check('"Desbloquear equipo" abre todo y apaga el bloqueo',
        !store.ajustes().bloqueoActivo && Object.values(mock.switches).every((v) => v === 'FUNC_SW_ON'));
    silenciar();

    // Modo retención de punta a punta: una sola identificación, en la app.
    // La persona se valida con su usuario y PIN de la app; en el driver puso ese usuario
    // como Nombre y ese PIN como Contraseña, desde la cuenta de Windows "KuboC".
    equipo({ retencion: { KuboC: [{ doc: 'ric', pin: '1234' }, { doc: 'otro', pin: '9999' }, { doc: 'ric_1', pin: '1234' }] } });
    store.agregarUsuario('ric', '1234');
    mock.pulsar('modo');
    hablar();
    check('Ajustes pasa a modo retención', store.ajustes().modo === 'retencion', mock.textos());
    silenciar();
    mock.pulsar('salir');
    mock.pulsar('entrar');
    teclear('ric');
    mock.pulsar('seguir');
    teclear('0000'); mock.pulsar('OK');
    hablar();
    check('PIN malo: no entra', /incorrecto/.test(mock.textos()) && !sesion.activa(), mock.textos());
    silenciar();
    teclear('1234'); mock.pulsar('OK');
    hablar();
    check('validado en la máquina, lista SUS documentos retenidos', /ric · 2 documento/.test(mock.textos())
        && /Documento 2/.test(mock.textos()) && !/otro/.test(mock.textos()), mock.textos());
    check('y la sesión queda a nombre de la persona, no de Windows', sesion.usuario() === 'ric', sesion.usuario());
    silenciar();
    mock.pulsar('r1');
    hablar();
    check('Imprimir libera ese documento', mock.liberados.join() === 'ric_1' && /Imprimiendo/.test(mock.textos()), mock.textos());
    silenciar();
    await esperar(config.RETENCION_RELEER_MS + 300);
    hablar();
    check('y la lista se vuelve a pedir sola', /ric · 1 documento/.test(mock.textos()) && !/No se confirmó/.test(mock.textos()), mock.textos());
    check('en retención también hay botón para salir a la impresora', /Menú del equipo/.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('terminar');

    // Retención con "Copia: con PIN": al entrar se abre la copia y hay "Ir a copiar".
    equipo({ retencion: { KuboC: [{ doc: 'ric', pin: '1234' }] } });
    store.agregarUsuario('ric', '1234');
    store.cambiarAjuste('modo', 'retencion');
    store.cambiarAjuste('bloquearCopia', true);
    (await import('./.build/acciones.mjs')).fijarBloqueo(true);
    hablar();
    check('retención + copia con PIN: sin nadie dentro la copia está cerrada',
        store.ajustes().bloqueoActivo && mock.switches.FUNC_T_COPY === 'FUNC_SW_OFF' && mock.switches.FUNC_T_NET_PRINT === 'FUNC_SW_ON',
        JSON.stringify(mock.switches));
    silenciar();
    mock.pulsar('entrar');
    teclear('ric');
    mock.pulsar('seguir');
    teclear('1234'); mock.pulsar('OK');
    hablar();
    check('al entrar se abre la copia y aparece "Ir a copiar"', mock.switches.FUNC_T_COPY === 'FUNC_SW_ON'
        && /Ir a copiar/.test(mock.textos()), mock.textos() + ' ' + JSON.stringify(mock.switches));
    let alMenu = 0;
    const onBackReal = globalThis.process.on_back;
    globalThis.process.on_back = () => { alMenu++; };
    mock.pulsar('Ir a copiar');
    globalThis.process.on_back = onBackReal;
    check('"Ir a copiar" sale al menú de la impresora sin cerrar la sesión', alMenu === 1 && sesion.activa());
    // Lo que antes la traía al frente a los pocos segundos: repintados, reloj, la copia contada.
    const router = await import('./.build/router.mjs');
    const dibujosAntes = mock.dibujos();
    // Todo dibujo pasa por el router: repintado periódico, reloj de la sesión y copia contada.
    router.repintar();
    await esperar(config.REPINTADO_MS + 300);
    check('mientras copia, la app NO se dibuja (no le quita la pantalla)', mock.dibujos() === dibujosAntes,
        (mock.dibujos() - dibujosAntes) + ' dibujos');
    globalThis.process.on_front();
    check('al volver a la app se dibuja su pantalla', mock.dibujos() > dibujosAntes && /Ir a copiar/.test(mock.textos()), mock.textos());
    silenciar();
    mock.pulsar('terminar');
    hablar();
    check('al terminar la copia se vuelve a cerrar', mock.switches.FUNC_T_COPY === 'FUNC_SW_OFF', JSON.stringify(mock.switches));
    silenciar();
    historial.detener();

    // Mismo panel, otro equipo: uno que acepta la orden y no bloquea.
    const { abrirAjustes } = await import('./.build/ajustes.mjs');
    equipo({ ignora: ['FUNC_T_NET_PRINT'] });
    store.agregarUsuario('ana', '4321');
    abrirAjustes(() => {});
    mock.pulsar('bloqueo');
    hablar();
    check('si el equipo no bloquea, lo dice y deja el bloqueo apagado',
        /No se pudo bloquear/.test(mock.textos()) && !store.ajustes().bloqueoActivo, mock.textos());
}

hablar(); console.log('· Panel web servido por la impresora'); silenciar();
{
    const web = await import('./.build/web.mjs');
    equipo();
    web._reiniciar();
    store.agregarUsuario('ana', '4321');
    const r = web.instalar();
    const BASE = '/pedk/app_notify/' + config.WEB_APP;
    // La forma de la petición no está documentada: se prueba con {url, method, body} en texto.
    const pedir = (ruta, metodo, cuerpo) => mock.pedk.net.http.receiveData(
        { url: BASE + ruta, method: metodo || 'GET', body: cuerpo || '' });
    const token = (html) => (/(?:name="s" value="|[?]s=)([0-9a-f]+)/.exec(html) || [])[1];
    // La lista la pinta el navegador: se ejecuta lista.js con un DOM mínimo y se leen las filas.
    /** Lo que pinta contadores.js: [{nombre, detalle, celdas, clase}]. */
    const verContadores = async (tok) => {
        const el = (tag) => ({ tag, children: [], textContent: '', className: '', attrs: {},
            appendChild(c) { this.children.push(c); return c; }, getAttribute(k) { return this.attrs[k]; } });
        const T = el('table');
        T.attrs['data-s'] = tok;
        let mayor = 0;
        const ctx = {
            document: { getElementById: () => T, createElement: el },
            fetch: (url) => {
                const [ruta, q] = url.split('?');
                const b = pedir('/' + ruta, 'GET', q).body;
                mayor = Math.max(mayor, web.bytesUtf8(b));
                return Promise.resolve({ text: () => Promise.resolve(b) });
            },
        };
        new Function(...Object.keys(ctx), pedir('/contadores.js').body)(...Object.values(ctx));
        await esperar(30);
        const filas = T.children.filter((r) => r.tag === 'tr' && r.children.length === 6).map((r) => ({
            nombre: r.children[0].children[0].textContent,
            detalle: (r.children[0].children[2] || {}).textContent || '',
            celdas: r.children.slice(1).map((c) => (c.children[0] || c).textContent),
            clase: r.className,
        }));
        return { filas, mayor, texto: T.textContent };
    };
    /** Una copia con `n` personas del tamaño de las reales (nombre, cédula, contadores). */
    const copiaDe = (n) => {
        const usuarios = [];
        const contadores = {};
        for (let i = 0; i < n; i++) {
            const nombre = 'usuario.' + String(i).padStart(5, '0');
            usuarios.push({ nombre, huella: (0x10000000 + i * 7919).toString(16) + (0x20000000 + i * 104729).toString(16),
                activo: true, creado: '2026-09-21T12:00:00.000Z', cedula: String(1700000000 + i),
                nombreCompleto: 'Nombre Segundo Apellido Apellido ' + i });
            contadores[nombre] = { impresiones: 120 + i, paginas: 1500 + i, copias: 30, paginasCopia: 400 };
        }
        return { formato: 1, app: config.WEB_APP, usuarios, contadores, registro: [],
            ajustes: { modo: 'retencion', bloqueoActivo: true, bloquearCopia: true, minutosSesion: 3, huellaAdmin: null } };
    };
    let listaJs = null;   // se lee una vez: una prueba baja el tope y el script ya no cabría
    const verLista = async (tok) => {
        const el = (tag) => ({ tag, children: [], textContent: '', className: '', attrs: {},
            appendChild(c) { this.children.push(c); return c; }, getAttribute(k) { return this.attrs[k]; } });
        const T = el('table');
        T.attrs['data-s'] = tok;
        let partes = 0;
        let mayor = 0;
        const ctx = {
            document: { getElementById: () => T, createElement: el },
            fetch: (url) => {
                partes++;
                const [ruta, q] = url.split('?');
                const b = pedir('/' + ruta, 'GET', q).body;
                mayor = Math.max(mayor, web.bytesUtf8(b));
                return Promise.resolve({ text: () => Promise.resolve(b) });
            },
        };
        listaJs = listaJs || pedir('/lista.js').body;
        new Function(...Object.keys(ctx), listaJs)(...Object.values(ctx));
        await esperar(30);
        const filas = T.children.filter((r) => r.tag === 'tr' && r.children.length === 3).map((r) => ({
            nombre: r.children[0].children[0].textContent,
            completo: (r.children[0].children[2] || {}).textContent || '',
            estado: (r.children[1].children[0] || r.children[1]).textContent,
            botones: r.children[2].children.map((b) => b.value + '=' + b.textContent),
            clase: r.className,
        }));
        return { filas, partes, mayor, texto: T.textContent };
    };
    hablar();
    check('se engancha a receiveData', r.ok, r.motivo);

    let resp = pedir('');
    check('sin sesión enseña el login', resp.code === 200 && /PIN de administrador/.test(resp.body) && !/ana/.test(resp.body));
    check('lee ruta, método y campos de url y cuerpo',
        JSON.stringify(web.leerPeticion({ url: 'http://1.2.3.4' + BASE + '/usuarios/alta/?s=abc', method: 'post', body: 'nombre=Pe%C3%B1a+x&pin=12' }))
        === JSON.stringify({ ruta: '/usuarios/alta', metodo: 'POST', datos: { s: 'abc', nombre: 'Peña x', pin: '12' } }));
    check('entiende acentos en Latin-1 además de UTF-8',
        web.leerPeticion({ url: BASE, body: 'a=Jos%E9+P%E9rez+%D1u&b=Jos%C3%A9' }).datos.a === 'José Pérez Ñu'
        && web.leerPeticion({ url: BASE, body: 'b=Jos%C3%A9' }).datos.b === 'José');
    check('acepta el cuerpo como RequestBody o JSON',
        web.leerPeticion({ url: BASE, body: { data: { pin: 1 } } }).datos.pin === '1'
        && web.leerPeticion({ url: BASE, body: '{"pin":"2"}' }).datos.pin === '2');

    resp = pedir('/entrar', 'POST', 'pin=9999');
    check('PIN de administrador malo no entra', /PIN incorrecto/.test(resp.body) && !token(resp.body));
    resp = pedir('/usuarios', 'GET', 's=inventado');
    check('un token inventado no vale', /caducó/.test(resp.body) && !/ana/.test(resp.body));

    resp = pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA);
    const s = token(resp.body);
    check('el PIN de administrador abre la sesión y lista usuarios', !!s && /Usuarios \(1\)/.test(resp.body)
        && (await verLista(s)).filas.some((f) => f.nombre === 'ana'));
    check('avisa de que el PIN de admin es el de fábrica', /de fábrica/.test(resp.body));
    check('nunca muestra PIN ni huellas', !/4321/.test(resp.body) && !resp.body.includes(store.huella('ana', '4321')));

    resp = pedir('/alta', 'POST', 's=' + s + '&nombre=Beto&pin=5678');
    check('da de alta desde la web', /beto dado de alta/.test(resp.body) && store.validarUsuario('beto', '5678').ok);
    resp = pedir('/alta', 'POST', 's=' + s + '&nombre=beto&pin=1111');
    check('no admite repetidos', /ya existe/.test(resp.body));
    pedir('/alta', 'GET', 's=' + s + '&nombre=cid&pin=1111');
    check('por GET no cambia nada', !store.usuarios().some((u) => u.nombre === 'cid'));
    pedir('/cambiar', 'GET', 's=' + s + '&nombre=beto&a=borrar');
    check('ni borra', store.usuarios().some((u) => u.nombre === 'beto'));

    resp = pedir('/cambiar', 'POST', 's=' + s + '&nombre=beto&a=pin&pin=12');
    check('rechaza un PIN corto', /dígitos/.test(resp.body) && store.validarUsuario('beto', '5678').ok);
    resp = pedir('/cambiar', 'POST', 's=' + s + '&nombre=beto&a=pin&pin=2468');
    check('cambia el PIN', /cambiado/.test(resp.body) && store.validarUsuario('beto', '2468').ok);

    pedir('/cambiar', 'POST', 's=' + s + '&nombre=beto&a=desactivar');
    check('desactiva', !store.validarUsuario('beto', '2468').ok);
    pedir('/cambiar', 'POST', 's=' + s + '&nombre=beto&a=activar');
    check('y vuelve a activar', store.validarUsuario('beto', '2468').ok);

    resp = pedir('/cambiar', 'POST', 's=' + s + '&nombre=beto&a=borrar');
    check('borra', /beto borrado/.test(resp.body) && !store.usuarios().some((u) => u.nombre === 'beto'));

    // Acciones visibles en cada fila de la lista.
    store.agregarUsuario('lola', '1357', { nombreCompleto: 'Lola Martínez' });
    let lola = (await verLista(s)).filas.filter((f) => f.nombre === 'lola')[0];
    check('cada fila tiene Editar, Desactivar y Borrar a la vista', lola && lola.completo === 'Lola Martínez'
        && lola.botones.join('|') === 'e lola=Editar|d lola=Desactivar|b lola=Borrar', JSON.stringify(lola));
    resp = pedir('/lista', 'POST', 's=' + s + '&x=d+lola');
    lola = (await verLista(s)).filas.filter((f) => f.nombre === 'lola')[0];
    check('desactivar desde la lista', !store.validarUsuario('lola', '1357').ok && /lola desactivado/.test(resp.body)
        && lola.estado === 'desactivado' && lola.clase === 'inactivo' && lola.botones[1] === 'a lola=Activar');
    check('Editar abre la ficha', /Cambiar PIN/.test(pedir('/lista', 'POST', 's=' + s + '&x=e+lola').body));
    pedir('/lista', 'POST', 's=' + s + '&x=a+lola');
    check('activar desde la lista', store.validarUsuario('lola', '1357').ok);
    pedir('/lista', 'GET', 's=' + s + '&x=b+lola');
    check('por GET la lista no borra', store.usuarios().some((u) => u.nombre === 'lola'));
    resp = pedir('/lista', 'POST', 's=' + s + '&x=b+lola');
    check('borrar desde la lista', !store.usuarios().some((u) => u.nombre === 'lola') && /lola borrado/.test(resp.body));
    check('sobre alguien que no existe lo dice', /No existe/.test(pedir('/lista', 'POST', 's=' + s + '&x=d+nadie').body));
    check('sin sesión la lista no hace nada', (() => {
        store.agregarUsuario('lola', '1357');
        pedir('/lista', 'POST', 'x=b+lola');
        return store.usuarios().some((u) => u.nombre === 'lola');
    })());
    store.quitarUsuario('lola');

    resp = pedir('/alta', 'POST', 's=' + s + '&nombre=' + encodeURIComponent('<script>') + '&pin=1234');
    check('escapa lo que pinta', !/<script>/.test(resp.body), resp.body.slice(0, 200));

    resp = pedir('/salir', 'POST', 's=' + s);
    check('salir cierra la sesión', /Sesión cerrada/.test(resp.body) && /caducó/.test(pedir('/usuarios', 'GET', 's=' + s).body));

    const t0 = Date.now();
    const p = (pin) => web.atenderRuta({ ruta: '/entrar', metodo: 'POST', datos: { pin } }, t0);
    for (let i = 0; i < config.INTENTOS_MAX; i++) p('0000');
    check('frena tras varios PIN malos, aunque luego acierte', /Demasiados intentos/.test(p(config.PIN_ADMIN_FABRICA).cuerpo));
    store.olvidarFallos('#web-admin');

    const s2 = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    const tarde = Date.now() + config.WEB_SESION_MS + 1000;
    check('la sesión caduca sin uso',
        /caducó/.test(web.atenderRuta({ ruta: '/usuarios', metodo: 'GET', datos: { s: s2 } }, tarde).cuerpo));

    // El firmware se cuelga con respuestas grandes: con mucha gente, nada puede pasar del tope.
    const s3 = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    for (let i = 0; i < 60; i++) store.agregarUsuario('persona.larga.' + String(i).padStart(3, '0'), '1234');
    const vista = await verLista(s3);
    check('con 60 usuarios la página y los datos caben en el tope', vista.mayor <= config.WEB_MAX_BYTES
        && web.bytesUtf8(pedir('/usuarios', 'GET', 's=' + s3).body) <= config.WEB_MAX_BYTES, vista.mayor);
    check('y salen TODOS en una sola página', vista.filas.length === store.usuarios().length,
        vista.filas.length + ' de ' + store.usuarios().length);
    const topeReal = config.WEB_MAX_BYTES;
    config.WEB_MAX_BYTES = 400;
    const troceada = await verLista(s3);
    config.WEB_MAX_BYTES = topeReal;
    check('si los datos no caben de una vez, se piden por partes y no se pierde nadie',
        troceada.partes > 3 && troceada.filas.length === store.usuarios().length, troceada.partes + ' partes, ' + troceada.filas.length);
    check('sin sesión la lista no enseña a nadie', /caducó/.test((await verLista('inventado')).texto));
    const ficha = pedir('/usuario', 'GET', 's=' + s3 + '&n=persona.larga.007').body;
    check('la ficha de un usuario trae sus acciones y cabe',
        /Cambiar PIN/.test(ficha) && /Desactivar/.test(ficha) && /Borrar/.test(ficha)
        && web.bytesUtf8(ficha) <= config.WEB_MAX_BYTES, web.bytesUtf8(ficha));
    check('el estilo va aparte', /text\/css/.test(pedir('/estilo.css').headers.v));
    check('cuenta bytes UTF-8, no caracteres', web.bytesUtf8('añ€') === 6);
    check('una respuesta que no cabe se sustituye por un aviso corto',
        /no cabe/.test(pedir('/eco', 'GET', 'x=' + 'a'.repeat(0)).body) === false
        && (() => { const o = config.WEB_MAX_BYTES; config.WEB_MAX_BYTES = 100;
            const b = pedir('/entrar', 'POST', 'pin=0').body; config.WEB_MAX_BYTES = o; return /no cabe/.test(b); })());
    check('/tam mide el tope a propósito', pedir('/tam', 'GET', 'n=5000').body.length === 5000);

    // Contadores: 60 personas con trabajos, más lo que se imprimió sin identificarse.
    store.usuarios().forEach((u, i) => store.contar(u.nombre, { tipo: i % 3 ? 'PRINT' : 'COPY', paginas: i + 1 }));
    store.contar(store.SIN_SESION, { tipo: 'PRINT', paginas: 7 });
    const vc = await verContadores(s3);
    check('contadores: la página y los datos caben en el tope', vc.mayor <= config.WEB_MAX_BYTES
        && web.bytesUtf8(pedir('/contadores', 'GET', 's=' + s3).body) <= config.WEB_MAX_BYTES, vc.mayor);
    check('contadores: salen TODOS en una sola página', vc.filas.length === store.contadoresDeTodos().length,
        vc.filas.length + ' de ' + store.contadoresDeTodos().length);
    check('quien no se identificó sale como "Sin identificar"', vc.filas.some((f) => f.nombre === 'Sin identificar' && f.celdas[4] === '7'));

    // El CSV lo junta el navegador: se ejecuta el script de verdad con fetch simulado.
    const js = pedir('/csv.js').body;
    let bajado = null;
    let partes = 0;
    let mayorP = 0;
    const entorno = {
        fetch: (url) => {
            partes++;
            const [ruta, q] = url.split('?');
            const b = pedir('/' + ruta, 'GET', q).body;
            mayorP = Math.max(mayorP, web.bytesUtf8(b));
            return Promise.resolve({ text: () => Promise.resolve(b) });
        },
        Blob: function (trozos) { this.texto = trozos.join(''); },
        URL: { createObjectURL: (b) => b },
        document: { createElement: () => ({ click() { bajado = this; }, remove() {} }), body: { appendChild() {} } },
        alert: (m) => { bajado = { error: m }; },
    };
    new Function(...Object.keys(entorno), js + ';bajarCsv({getAttribute:()=>"' + s3 + '",disabled:false});')(...Object.values(entorno));
    await esperar(50);
    const csv = bajado && bajado.href && bajado.href.texto;
    const lineas = csv ? csv.split('\n').filter(Boolean) : [];
    check('el CSV se descarga en varias partes y cada una cabe', partes > 1 && mayorP <= config.WEB_MAX_BYTES, partes + ' partes, ' + mayorP + ' bytes');
    check('el CSV lleva BOM, cabecera, a todos y el TOTAL',
        !!csv && csv.charCodeAt(0) === 0xfeff && lineas.some((l) => /^Usuario;Nombre completo;Cedula;Estado;Impresiones/.test(l))
        && lineas.length - lineas.findIndex((l) => /^Usuario;/.test(l)) - 2 === store.contadoresDeTodos().length
        && /^TOTAL;/.test(lineas[lineas.length - 1]), bajado && (bajado.error || lineas.length));
    const tot = store.totales();
    check('el TOTAL del CSV cuadra', lineas.length && lineas[lineas.length - 1] === 'TOTAL;;;;' + tot.impresiones + ';'
        + tot.paginas + ';' + tot.copias + ';' + tot.paginasCopia + ';' + (tot.paginas + tot.paginasCopia), lineas[lineas.length - 1]);
    check('el CSV pide sesión', !/^SIGUIENTE/.test(pedir('/csv', 'GET', 'desde=0').body));

    pedir('/cero', 'GET', 's=' + s3);
    check('poner a cero por GET no hace nada', store.contadores().length > 0);
    resp = pedir('/cero', 'POST', 's=' + s3);
    check('poner a cero por POST', /Contadores a cero/.test(resp.body) && store.contadores().length === 0);

    // Nombre completo y cédula.
    store.usuarios().forEach((u) => store.quitarUsuario(u.nombre));
    store.reiniciarContadores();
    const enc = encodeURIComponent;
    resp = pedir('/alta', 'POST', 's=' + s3 + '&nombre=jperez&pin=1234&nombreCompleto=' + enc('  José   Pérez Núñez ')
        + '&cedula=' + enc('1712-345.678'));
    const jp = store.usuarios().filter((u) => u.nombre === 'jperez')[0];
    check('alta con nombre completo y cédula (acentos y espacios de más)',
        jp && jp.nombreCompleto === 'José Pérez Núñez' && jp.cedula === '1712345678', JSON.stringify(jp));
    check('la lista enseña el nombre completo', (await verLista(s3)).filas.some((f) => f.nombre === 'jperez' && f.completo === 'José Pérez Núñez'));
    resp = pedir('/alta', 'POST', 's=' + s3 + '&nombre=otro&pin=1234&nombreCompleto=Otra+Persona&cedula=1712345678');
    check('no deja repetir una cédula', /ya la tiene el usuario jperez/.test(resp.body) && !store.usuarios().some((u) => u.nombre === 'otro'));
    check('y no hace volver a escribirlo todo', /value="Otra Persona"/.test(resp.body) && /value="otro"/.test(resp.body));
    resp = pedir('/alta', 'POST', 's=' + s3 + '&nombre=otro&pin=1234&cedula=12');
    check('rechaza una cédula demasiado corta', /Cédula no válida/.test(resp.body));
    check('nombre y cédula son opcionales', pedir('/alta', 'POST', 's=' + s3 + '&nombre=anon&pin=1234') && store.usuarios().some((u) => u.nombre === 'anon'));
    check('el nombre no puede meter HTML', !/<x>/.test(pedir('/usuario', 'GET', 's=' + s3 + '&n=anon').body)
        && store.cambiarDatosUsuario('anon', { nombreCompleto: 'a<x>b' }).ok && !/<x>/.test(pedir('/usuario', 'GET', 's=' + s3 + '&n=anon').body));

    resp = pedir('/cambiar', 'POST', 's=' + s3 + '&nombre=jperez&a=datos&nombreCompleto=' + enc('José Pérez') + '&cedula=');
    const jp2 = store.usuarios().filter((u) => u.nombre === 'jperez')[0];
    check('la ficha guarda los datos (y vaciar la cédula la quita)', /Datos guardados/.test(resp.body)
        && jp2.nombreCompleto === 'José Pérez' && jp2.cedula === '', JSON.stringify(jp2));
    check('su propia cédula no cuenta como repetida', store.cambiarDatosUsuario('jperez', { cedula: '99999', nombreCompleto: 'José Pérez' }).ok
        && store.cambiarDatosUsuario('jperez', { cedula: '99999', nombreCompleto: 'J P' }).ok);
    check('la ficha cabe con un nombre largo con acentos', (() => {
        store.cambiarDatosUsuario('jperez', { nombreCompleto: 'Ñ'.repeat(config.NOMBRE_COMPLETO_MAX) });
        return web.bytesUtf8(pedir('/usuario', 'GET', 's=' + s3 + '&n=jperez').body) <= config.WEB_MAX_BYTES;
    })());
    check('más largo que el máximo no se guarda', !store.cambiarDatosUsuario('jperez', { nombreCompleto: 'a'.repeat(config.NOMBRE_COMPLETO_MAX + 1) }).ok);
    store.cambiarDatosUsuario('jperez', { nombreCompleto: 'José Pérez', cedula: '99999' });

    // Los contadores enseñan a todos, también a quien no imprimió.
    store.contar('jperez', { tipo: 'PRINT', paginas: 3 });
    store.contar('fantasma', { tipo: 'PRINT', paginas: 2 });
    const todos = store.contadoresDeTodos();
    check('contadores de todos: los que no imprimieron salen con cero',
        todos.some((c) => c.quien === 'anon' && c.paginas === 0) && todos[0].quien === 'jperez', JSON.stringify(todos.map((c) => c.quien)));
    check('y quien ya no existe pero imprimió sale como borrado', todos.some((c) => c.quien === 'fantasma' && !c.existe));
    const vc2 = await verContadores(s3);
    check('la página de contadores enseña al que tiene cero, en gris', vc2.filas.some((f) => f.nombre === 'anon' && f.clase === 'inactivo')
        && vc2.filas.some((f) => f.nombre === 'fantasma' && f.detalle === 'usuario borrado'), JSON.stringify(vc2.filas.slice(0, 4)));
    const p0 = pedir('/csv', 'GET', 's=' + s3 + '&desde=0').body;
    check('el CSV lleva nombre completo, cédula y estado', /\njperez;José Pérez;99999;activo;1;3;0;0;3\n/.test(p0)
        && /\nanon;a x b;;activo;0;0;0;0;0\n/.test(p0) && /\nfantasma;;;borrado;1;2/.test(p0), p0);

    // Viajan en la copia de seguridad y vuelven al restaurar.
    const copia = JSON.parse(JSON.stringify(store.respaldo()));
    store.quitarUsuario('jperez');
    store.restaurarUsuarios(copia);
    const vuelto = store.usuarios().filter((u) => u.nombre === 'jperez')[0];
    check('nombre y cédula sobreviven a respaldar y restaurar', vuelto && vuelto.nombreCompleto === 'José Pérez' && vuelto.cedula === '99999');
    store.restaurarUsuarios([{ nombre: 'jperez', pin: '1234' }]);
    check('un fichero sin esos datos no los borra', store.usuarios().filter((u) => u.nombre === 'jperez')[0].cedula === '99999');

    // Ajustes desde la web: la MISMA lógica que el panel (acciones.js).
    const acciones = await import('./.build/acciones.mjs');
    // Un equipo que SÍ retiene (el simulado por defecto no), con una persona dada de alta.
    equipo({ retencion: { KuboC: [] } });
    web._reiniciar();
    web.instalar();
    store.agregarUsuario('jperez', '1234');
    const sA = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    let avisos = 0;
    acciones.alCambiar(() => { avisos++; });
    const aj = pedir('/ajustes', 'GET', 's=' + sA).body;
    check('la página de ajustes cabe y enseña modo y bloqueo', web.bytesUtf8(aj) <= config.WEB_MAX_BYTES
        && /Modo<\/th><td><b>sesión/.test(aj) && /Bloqueo<\/th><td><b>apagado/.test(aj), web.bytesUtf8(aj));
    pedir('/ajuste', 'GET', 's=' + sA + '&a=bloqueo');
    check('por GET no cambia ningún ajuste', !store.ajustes().bloqueoActivo);
    resp = pedir('/ajuste', 'POST', 's=' + sA + '&a=bloqueo');
    check('encender el bloqueo desde la web bloquea el equipo de verdad',
        store.ajustes().bloqueoActivo && cerradura.impresionBloqueada() === true && /Bloqueo<\/th><td><b>ENCENDIDO/.test(resp.body), resp.body.slice(-300));
    check('y avisa al panel para que repinte', avisos > 0);
    resp = pedir('/ajuste', 'POST', 's=' + sA + '&a=modo');
    check('pasar a retención reabre la impresión desde PC (si no, no llegan los documentos)',
        store.ajustes().modo === 'retencion' && cerradura.impresionBloqueada() === false, resp.body.slice(-300));
    pedir('/ajuste', 'POST', 's=' + sA + '&a=modo');
    check('y volver a sesión la cierra', store.ajustes().modo === 'sesion' && cerradura.impresionBloqueada() === true);
    sesion.abrir('jperez', '1234');
    resp = pedir('/ajuste', 'POST', 's=' + sA + '&a=modo');
    check('con alguien usando la impresora no cambia el modo', store.ajustes().modo === 'sesion' && /usando la impresora/.test(resp.body));
    sesion.cerrar('prueba');
    resp = pedir('/ajuste', 'POST', 's=' + sA + '&a=minutos&minutos=7');
    check('minutos fuera de las opciones no valen', /no válida/.test(resp.body));
    pedir('/ajuste', 'POST', 's=' + sA + '&a=minutos&minutos=' + config.MINUTOS_SESION_OPCIONES[0]);
    check('minutos válidos se guardan', store.ajustes().minutosSesion === config.MINUTOS_SESION_OPCIONES[0]);
    pedir('/ajuste', 'POST', 's=' + sA + '&a=desbloquear');
    check('desbloquear apaga el bloqueo y abre el equipo', !store.ajustes().bloqueoActivo && cerradura.impresionBloqueada() === false);

    // PIN de administrador.
    const otraSesion = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    check('la página del PIN cabe', web.bytesUtf8(pedir('/pinadmin', 'GET', 's=' + sA).body) <= config.WEB_MAX_BYTES);
    resp = pedir('/pinadmin', 'POST', 's=' + sA + '&actual=0000&nuevo=13579&repetir=13579');
    check('sin el PIN actual no se cambia', /no es correcto/.test(resp.body) && store.pinAdminDeFabrica());
    resp = pedir('/pinadmin', 'POST', 's=' + sA + '&actual=' + config.PIN_ADMIN_FABRICA + '&nuevo=13579&repetir=13570');
    check('si los dos nuevos no coinciden no se cambia', /no coinciden/.test(resp.body) && store.pinAdminDeFabrica());
    resp = pedir('/pinadmin', 'POST', 's=' + sA + '&actual=' + config.PIN_ADMIN_FABRICA + '&nuevo=13579&repetir=13579');
    check('cambia el PIN de administrador (el mismo del panel)', /cambiado/.test(resp.body) && store.esPinAdmin('13579') && !store.pinAdminDeFabrica());
    check('y cierra las otras sesiones, no la propia', /caducó/.test(pedir('/usuarios', 'GET', 's=' + otraSesion).body)
        && /Usuarios \(/.test(pedir('/usuarios', 'GET', 's=' + sA).body));
    check('el PIN de fábrica ya no entra', /incorrecto/.test(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body));
    store.olvidarFallos('#web-admin');

    // Copia de seguridad desde el navegador: descargar de una impresora y subir a otra vacía.
    const navegador = (sesionTok, archivo, comprimir = true) => {
        const env = { bajado: null, estado: { textContent: '', className: '' }, posts: [] };
        env.ctx = {
            fetch: (url, o) => {
                const [ruta, q] = url.split('?');
                if (o && o.method === 'POST') env.posts.push(o.body);
                const b = o && o.method === 'POST' ? pedir('/' + ruta, 'POST', o.body).body : pedir('/' + ruta, 'GET', q).body;
                return Promise.resolve({ text: () => Promise.resolve(b) });
            },
            // Un Blob de verdad (la subida lo comprime con stream()) que además recuerda su texto.
            Blob: function (trozos, o) { const b = new globalThis.Blob(trozos, o); b.texto = trozos.join(''); return b; },
            URL: { createObjectURL: (b) => b },
            Response: globalThis.Response,
            CompressionStream: comprimir ? globalThis.CompressionStream : undefined,
            btoa: globalThis.btoa,
            document: {
                createElement: () => ({ click() { env.bajado = this.href.texto; }, remove() {} }),
                body: { appendChild() {} },
                getElementById: (id) => (id === 'f' ? { files: archivo ? [archivo] : [] } : env.estado),
            },
            alert: (m) => { env.estado.textContent = 'ALERTA ' + m; },
            confirm: () => true,
        };
        const js = pedir('/copia-bajar.js').body + ';' + pedir('/subir.js').body + ';' + pedir('/copia-subir.js').body;
        env.correr = (llamada) => new Function(...Object.keys(env.ctx), js + ';' + llamada)(...Object.values(env.ctx));
        env.boton = '{getAttribute:()=>"' + sesionTok + '",disabled:false}';
        return env;
    };
    check('los scripts de la copia caben', ['/copia-bajar.js', '/copia-subir.js'].every((r) =>
        /^function/.test(pedir(r).body) && web.bytesUtf8(pedir(r).body) <= config.WEB_MAX_BYTES));

    // Impresora "de antes": configurada y con datos, con acentos y bastante registro.
    store.agregarUsuario('nono', '2468', { nombreCompleto: 'Íñigo Núñez 😀', cedula: '123456789' });
    for (let i = 0; i < 40; i++) store.contar('jperez', { tipo: 'PRINT', paginas: 2, doc: 'Informe año ' + i + '.pdf' });
    store.contar('nono', { tipo: 'COPY', paginas: 5 });
    pedir('/ajuste', 'POST', 's=' + sA + '&a=modo');
    pedir('/ajuste', 'POST', 's=' + sA + '&a=bloqueo');
    pedir('/ajuste', 'POST', 's=' + sA + '&a=copia');
    const antes = JSON.parse(JSON.stringify(store.respaldo()));
    check('la impresora de antes está en retención con bloqueo', antes.ajustes.modo === 'retencion' && antes.ajustes.bloqueoActivo);
    check('la página de copia cabe', web.bytesUtf8(pedir('/copia', 'GET', 's=' + sA).body) <= config.WEB_MAX_BYTES);

    const nav1 = navegador(sA);
    let partesCopia = 0;
    const fetchOriginal = nav1.ctx.fetch;
    nav1.ctx.fetch = (url, o) => { partesCopia++; return fetchOriginal(url, o); };
    nav1.correr('bajarCopia(' + nav1.boton + ')');
    await esperar(50);
    const fichero = nav1.bajado;
    check('descarga la copia completa en varias partes', !!fichero && partesCopia > 1
        && JSON.stringify(JSON.parse(fichero).usuarios) === JSON.stringify(antes.usuarios)
        && JSON.stringify(JSON.parse(fichero).contadores) === JSON.stringify(antes.contadores), partesCopia + ' partes');
    check('y cada parte cabe en lo que la impresora puede enviar', (() => {
        let d = 0; let mayorParte = 0;
        for (;;) {
            const b = pedir('/copia.json', 'GET', 's=' + sA + '&desde=' + d).body;
            mayorParte = Math.max(mayorParte, web.bytesUtf8(b));
            const m = /^SIGUIENTE;(-?\d+)\n/.exec(b);
            if (!m || +m[1] < 0) break;
            d = +m[1];
        }
        return mayorParte <= config.WEB_MAX_BYTES;
    })());
    check('la copia pide sesión', !/^SIGUIENTE/.test(pedir('/copia.json', 'GET', 'desde=0').body));

    // Impresora "reinstalada": vacía, PIN de fábrica.
    equipo({ retencion: { KuboC: [] } });
    web._reiniciar();
    web.instalar();
    const sN = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    const nav2 = navegador(sN, { name: 'copia.json', text: () => Promise.resolve(fichero) });
    nav2.correr('subirCopia(' + nav2.boton + ')');
    await esperar(100);
    check('sube la copia y dice que fue bien', nav2.estado.className === 'ok' && /Copia restaurada/.test(nav2.estado.textContent), nav2.estado.textContent);
    const mayorPost = Math.max(...nav2.posts.map((b) => b.length));
    check('en varios envíos, todos muy por debajo de lo que cuelga la impresora (502 medido bueno)',
        nav2.posts.length > 3 && mayorPost <= 320, nav2.posts.length + ' envíos, el mayor ' + mayorPost);
    const despues = store.respaldo();
    check('vuelven los usuarios con su PIN, nombre y cédula (con acentos y emoji)',
        store.validarUsuario('nono', '2468').ok && store.validarUsuario('jperez', '1234').ok
        && store.usuarios().filter((u) => u.nombre === 'nono')[0].nombreCompleto === 'Íñigo Núñez 😀');
    check('vuelven los contadores y el registro', JSON.stringify(despues.contadores) === JSON.stringify(antes.contadores)
        && despues.registro.length === antes.registro.length);
    check('vuelven los ajustes y el PIN de administrador', despues.ajustes.bloquearCopia === true
        && despues.ajustes.huellaAdmin === antes.ajustes.huellaAdmin);
    check('modo y bloqueo se aplican de verdad, como en el panel',
        store.ajustes().modo === 'retencion' && store.ajustes().bloqueoActivo && cerradura.impresionBloqueada() === false);

    // Lo que no debe pasar.
    store.contar('jperez', { tipo: 'PRINT', paginas: 100 });
    const conCifras = JSON.stringify(store.contadores());
    const nav3 = navegador(sN, { name: 'copia.json', text: () => Promise.resolve(fichero) });
    nav3.correr('subirCopia(' + nav3.boton + ')');
    await esperar(100);
    check('con contadores ya en marcha no los pisa', JSON.stringify(store.contadores()) === conCifras
        && /se conservan los actuales/.test(nav3.estado.textContent), nav3.estado.textContent);
    const nav4 = navegador(sN, { name: 'x.json', text: () => Promise.resolve('no soy json') });
    nav4.correr('subirCopia(' + nav4.boton + ')');
    await esperar(20);
    check('un fichero que no es JSON se rechaza sin enviar nada', nav4.posts.length === 0 && /no es una copia/.test(nav4.estado.textContent));
    const nav5 = navegador(sN, { name: 'x.json', text: () => Promise.resolve('{"app":"otra","usuarios":[]}') });
    nav5.correr('subirCopia(' + nav5.boton + ')');
    await esperar(50);
    check('una copia de otra app se rechaza', nav5.estado.className === 'error' && /otra app/.test(nav5.estado.textContent), nav5.estado.textContent);
    const vieja = JSON.stringify({ formato: 1, app: 'impresion-pin-BM5220ADW', usuarios: [{ nombre: 'vieja', huella: store.huella('vieja', '5555'), activo: true }] });
    const nav6 = navegador(sN, { name: 'ultimo.json', text: () => Promise.resolve(vieja) });
    nav6.correr('subirCopia(' + nav6.boton + ')');
    await esperar(50);
    check('vale una copia de antes del cambio de nombre (la del servidor del PC)', store.validarUsuario('vieja', '5555').ok, nav6.estado.textContent);
    check('un trozo desordenado se rechaza', /^ERROR;/.test(pedir('/subir', 'POST', 's=' + sN + '&u=x&i=3&t=5&d=abc').body));
    check('un trozo demasiado grande se rechaza', /^ERROR;/.test(pedir('/subir', 'POST', 's=' + sN + '&u=x&i=0&t=1&d=' + 'a'.repeat(config.WEB_TROZO_SUBIDA + 1)).body));
    check('subir pide sesión', !/^(SIGUE|OK|ERROR)/.test(pedir('/subir', 'POST', 'u=x&i=0&t=1&d=e30').body));
    check('base64url con acentos y emoji', web.desdeBase64url(Buffer.from('añ€😀', 'utf8').toString('base64url')) === 'añ€😀');

    // ---- Importar usuarios desde Excel (ficheros guardados por Excel de verdad) ----
    const { DOMParser } = await import('@xmldom/xmldom');
    const { readFileSync: leerF } = await import('fs');
    const fx = (n) => leerF(join(aqui, 'fixtures', n));
    const archivoDe = (nombre, buf) => ({
        name: nombre,
        arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
        text: () => Promise.resolve(buf.toString('utf8')),
    });
    /** Lo que hace la página /importar: cargar los scripts por partes y dar los botones. */
    const paginaImportarEn = async (tok, archivo) => {
        const els = { f: { files: archivo ? [archivo] : [] }, e: { textContent: '', className: '' }, v: { innerHTML: '' },
            b: { disabled: true, getAttribute: () => tok } };
        let codigo = '';
        let mayorParte = 0;
        for (const n of ['tabla', 'subir', 'importar']) {
            for (let d = 0; ;) {
                const b = pedir('/js', 'GET', 'n=' + n + '&desde=' + d).body;
                mayorParte = Math.max(mayorParte, web.bytesUtf8(b));
                const m = /^SIGUIENTE;(-?\d+)\n/.exec(b);
                codigo += b.slice(m[0].length);
                if (+m[1] < 0) break;
                d = +m[1];
            }
            codigo += '\n';
        }
        const env = { bajado: null, mayorParte };
        const ctx = {
            document: { getElementById: (id) => els[id], body: { appendChild() {} },
                createElement: () => ({ click() { env.bajado = this.href; }, remove() {} }) },
            fetch: (url, o) => {
                const [ruta, q] = url.split('?');
                const b = o && o.method === 'POST' ? pedir('/' + ruta, 'POST', o.body).body : pedir('/' + ruta, 'GET', q).body;
                return Promise.resolve({ text: () => Promise.resolve(b) });
            },
            DOMParser, URL: { createObjectURL: (b) => b }, alert: (m) => { els.e.textContent = 'ALERTA ' + m; }, confirm: () => true,
            Blob: globalThis.Blob, Response: globalThis.Response, TextDecoder: globalThis.TextDecoder, atob: globalThis.atob, btoa: globalThis.btoa,
            CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream,
        };
        env.fn = new Function(...Object.keys(ctx), codigo + ';return {revisar,importar,bajarPlantilla}')(...Object.values(ctx));
        env.els = els;
        return env;
    };
    const filasVista = (html) => (html.match(/<tr[^>]*><td>\d+<\/td>.*?<\/tr>/g) || [])
        .map((tr) => tr.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/^\||\|$/g, ''));

    for (const [nombreFx, tipo] of [['importar-excel.xlsx', 'xlsx'], ['importar-excel.csv', 'csv']]) {
        equipo();
        web._reiniciar();
        web.instalar();
        store.agregarUsuario('ana', '4321', { nombreCompleto: 'Ana Original' });
        const tI = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
        const pagI = pedir('/importar', 'GET', 's=' + tI).body;
        check(tipo + ': la página de importar cabe y carga sus scripts', web.bytesUtf8(pagI) <= config.WEB_MAX_BYTES && /js\?v=[0-9a-f]+&n=/.test(pagI));
        const nav = await paginaImportarEn(tI, archivoDe(nombreFx, fx(nombreFx)));
        check(tipo + ': los scripts llegan por partes que caben', nav.mayorParte <= config.WEB_MAX_BYTES, nav.mayorParte);
        nav.fn.revisar();
        await esperar(150);
        const vista = filasVista(nav.els.v.innerHTML);
        check(tipo + ': la vista previa marca cada fila', vista.join(' / ') === [
            '2|lperez|Lucía Pérez Núñez|nuevo',
            '3|mgomez|Mario Gómez|nuevo',
            '4|ana|Ana ya existe|ya existe: se salta',
            '5|lperez|Duplicado en el fichero|repetido en la fila 2',
            '6|corto|PIN demasiado corto|PIN de 4 a 8 números',
            '8|sincedula|nuevo',
            '9|mala cedula|Usuario con espacio|usuario no válido',
        ].join(' / '), vista.join(' / ') + ' · ' + nav.els.e.textContent);
        check(tipo + ': resume y deja importar', /^3 nuevos, 1 ya existen, 3 con errores/.test(nav.els.e.textContent) && nav.els.b.disabled === false,
            nav.els.e.textContent);
        check(tipo + ': la vista previa no enseña los PIN', !/0123|4567|24680/.test(nav.els.v.innerHTML));
        nav.fn.importar(nav.els.b);
        await esperar(150);
        const lp = store.usuarios().filter((u) => u.nombre === 'lperez')[0];
        check(tipo + ': importa los válidos con su PIN (con cero inicial)', /3 usuario\(s\) creados/.test(nav.els.e.textContent)
            && store.validarUsuario('lperez', '0123').ok && store.validarUsuario('mgomez', '4567').ok && store.validarUsuario('sincedula', '24680').ok,
            nav.els.e.textContent);
        check(tipo + ': conserva acentos y el cero inicial de la cédula', lp && lp.nombreCompleto === 'Lucía Pérez Núñez' && lp.cedula === '0912345678',
            JSON.stringify(lp));
        check(tipo + ': a quien ya existía no lo toca', store.validarUsuario('ana', '4321').ok
            && store.usuarios().filter((u) => u.nombre === 'ana')[0].nombreCompleto === 'Ana Original');
        check(tipo + ': los inválidos no entran', !store.usuarios().some((u) => /corto|mala/.test(u.nombre)) && store.usuarios().length === 4);
    }

    // La plantilla que se descarga es la de herramientas/.
    const navP = await paginaImportarEn(token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body));
    navP.fn.bajarPlantilla({ getAttribute: () => token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body) });
    await esperar(50);
    const plantillaBajada = navP.bajado ? Buffer.from(await navP.bajado.arrayBuffer()) : null;
    check('la plantilla descargada es la de herramientas/', plantillaBajada && plantillaBajada.equals(fx('../../herramientas/plantilla-usuarios.xlsx')));

    // La impresora vuelve a validar aunque alguien se salte el navegador.
    const directo = (tok, obj) => pedir('/subir', 'POST', 's=' + tok + '&k=importar&z=0&u=x&i=0&t=1&d='
        + Buffer.from(JSON.stringify(obj)).toString('base64url')).body;
    const tD = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
    resp = directo(tD, { filas: [[2, 'x y', '1'], [3, 'valido', '5555', '<b>', '12']] });
    check('la impresora revalida cada fila importada', /^ERROR;0 usuario\(s\) creados; 2 con errores: fila 2 \(x y: Usuario no válido/.test(resp)
        && !store.usuarios().some((u) => u.nombre === 'valido'), resp);
    const maxReal = config.USUARIOS_MAX;
    config.USUARIOS_MAX = store.usuarios().length + 1;
    resp = directo(tD, { filas: [[2, 'uno', '1111'], [3, 'dos', '2222']] });
    config.USUARIOS_MAX = maxReal;
    check('respeta el máximo de usuarios al importar', /1 usuario\(s\) creados; 1 con errores: fila 3 \(dos: Máximo/.test(resp), resp);

    // Máximo de usuarios en el alta manual y en el aviso de la lista.
    config.USUARIOS_MAX = store.usuarios().length;
    check('en el máximo el alta manual se niega', !store.agregarUsuario('otro.mas', '1234').ok
        && /borre alguno/.test(pedir('/nuevo', 'GET', 's=' + tD).body));
    config.USUARIOS_MAX = maxReal;
    const avisoReal = config.USUARIOS_AVISO;
    config.USUARIOS_AVISO = 2;
    check('pasado el aviso, la lista lo dice', /tarda más en guardar/.test(pedir('/usuarios', 'GET', 's=' + tD).body));
    config.USUARIOS_AVISO = avisoReal;

    // Una copia de 1000 usuarios se sube: comprimida en pocos trozos, y sin comprimir también.
    for (const comprimir of [true, false]) {
        equipo({ retencion: { KuboC: [] } });   // la copia trae modo retención: el equipo tiene que poder retener
        web._reiniciar();
        web.instalar();
        const tM = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
        const grande = JSON.stringify(copiaDe(1000));
        const navG = navegador(tM, { name: 'grande.json', text: () => Promise.resolve(grande) }, comprimir);
        navG.correr('subirCopia(' + navG.boton + ')');
        for (let i = 0; i < 300 && !navG.estado.className; i++) await esperar(20);
        check('copia de 1000 usuarios ' + (comprimir ? 'comprimida' : 'sin comprimir') + ': se restaura entera',
            store.usuarios().length === 1000 && navG.estado.className === 'ok', navG.estado.textContent);
        check('  y en ' + (comprimir ? 'menos de 200' : 'menos de ' + config.WEB_SUBIDA_MAX_TROZOS) + ' envíos',
            navG.posts.length < (comprimir ? 200 : config.WEB_SUBIDA_MAX_TROZOS), navG.posts.length);
    }

    // VELOCIDAD: cada petición cuesta ~1,15 s en el equipo y van de una en una (medido).
    {
        equipo();
        web._reiniciar();
        web.instalar();
        [['ana', 'Ana Ruiz'], ['beto', 'Beto Gil'], ['caro', 'Carolina Paz']].forEach(([n, c]) => store.agregarUsuario(n, '1234', { nombreCompleto: c }));
        store.contar('ana', { tipo: 'PRINT', paginas: 3 });
        const tV = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
        const recibir = (r, m, b) => mock.pedk.net.http.receiveData({ url: '/pedk/app_notify/' + config.WEB_APP + r, method: m || 'GET', body: b || '' });
        const pag = recibir('/usuarios', 'GET', 's=' + tV);
        const refs = pag.body.match(/(estilo\.css|lista\.js)\?v=[0-9a-f]{8}/g) || [];
        check('estilos y scripts se piden con su versión', refs.length === 2, refs.join(' '));
        const css = recibir('/estilo.css');
        check('y se sirven con caché de larga duración', /max-age=31536000/.test(css.headers.extra['Cache-Control'] || '')
            && /max-age/.test(recibir('/lista.js').headers.extra['Cache-Control'] || '')
            && /@import "estilo2\.css\?v=[0-9a-f]{8}"/.test(css.body));
        check('las páginas con datos NO se guardan en caché', !pag.headers.extra['Cache-Control']);
        // Los scripts escritos DENTRO de las páginas (cargador, carga diferida) también tienen
        // que ser JavaScript válido: no los ejecuta ninguna otra prueba.
        const enLinea = ['/usuarios', '/contadores', '/copia', '/importar'].flatMap((r) =>
            (recibir(r, 'GET', 's=' + tV).body.match(/<script>([\s\S]*?)<\/script>/g) || []).map((x) => [r, x.slice(8, -9)]));
        const malos = enLinea.filter(([, codigo]) => { try { new Function(codigo); return false; } catch (e) { return true; } });
        check('los scripts dentro de las páginas son válidos', enLinea.length >= 4 && malos.length === 0,
            enLinea.length + ' scripts; malos: ' + malos.map(([r]) => r).join(','));
        check('y los de las páginas esperan a que carguen los estilos', enLinea.every(([, c]) => /addEventListener\("load"/.test(c)));
        // Los datos de la lista vienen dentro de la página: el script no pide nada más.
        const dd = (/data-d="([^"]*)"/.exec(pag.body) || [])[1];
        check('la lista de usuarios viene dentro de la página si cabe', !!dd && /SIGUIENTE;-1/.test(dd));
        const des = (t) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const el = (tag) => ({ tag, children: [], textContent: '', className: '', attrs: {},
            appendChild(c) { this.children.push(c); return c; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } });
        let pedidas = 0;
        for (const [js, id, re] of [['/lista.js', 't', /data-d="([^"]*)"/], ['/contadores.js', 'c', /data-d="([^"]*)"/]]) {
            const pagina = js === '/lista.js' ? pag.body : recibir('/contadores', 'GET', 's=' + tV).body;
            const T = el('table');
            T.attrs['data-s'] = tV;
            T.attrs['data-d'] = des((re.exec(pagina) || [])[1] || '');
            const ctx = { document: { getElementById: () => T, createElement: el },
                fetch: () => { pedidas++; return Promise.resolve({ text: () => Promise.resolve('') }); } };
            new Function(...Object.keys(ctx), recibir(js).body)(...Object.values(ctx));
            await esperar(10);
            check(js + ': pinta con los datos de la página', T.children.filter((r) => r.tag === 'tr').length === store.contadoresDeTodos()
                .filter((c) => js === '/contadores.js' || c.existe).length, T.children.length);
        }
        check('y no hace ninguna petición más', pedidas === 0, pedidas);
        const topeV = config.WEB_MAX_BYTES;
        config.WEB_MAX_BYTES = web.bytesUtf8(pag.body) - 1;   // la página con datos ya no cabe
        const sinDatos = recibir('/usuarios', 'GET', 's=' + tV).body;
        config.WEB_MAX_BYTES = topeV;
        check('si los datos no caben, la página va sin ellos (y el script los pide)', !/data-d=/.test(sinDatos) && /lista\.js/.test(sinDatos));
    }

    // El respaldo al PC y la prueba de capacidad se quitaron (22-09-2026): los respaldos
    // los hace el administrador con la copia de seguridad.
    {
        const tQ = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
        const aj = pedir('/ajustes', 'GET', 's=' + tQ).body;
        check('Mantenimiento ofrece sólo copia de seguridad y PIN de administrador',
            /formaction="copia"/.test(aj) && /formaction="pinadmin"/.test(aj) && !/respaldo|capacidad/.test(aj));
        check('las direcciones del respaldo y la capacidad ya no hacen nada',
            /Usuarios \(/.test(pedir('/respaldo', 'POST', 's=' + tQ + '&a=subir').body)
            && /Usuarios \(/.test(pedir('/capacidad', 'POST', 's=' + tQ).body));
    }

    // Ninguna página, en su peor caso, puede caer en el aviso de "no cabe".
    {
        equipo({ retencion: { KuboC: [] } });
        web._reiniciar();
        web.instalar();
        const largo = 'usuario.largo.x20';
        store.agregarUsuario(largo, '1234', { nombreCompleto: 'Ñ'.repeat(config.NOMBRE_COMPLETO_MAX), cedula: '123456789012345' });
        (await import('./.build/acciones.mjs')).fijarBloqueo(true);
        store.cambiarAjuste('bloquearCopia', true);
        const tP = token(pedir('/entrar', 'POST', 'pin=' + config.PIN_ADMIN_FABRICA).body);
        sesion.abrir(largo, '1234');   // para los mensajes largos de "persona usando la impresora"
        const peores = [
            ['/', 'GET', ''], ['/entrar', 'POST', 'pin=0'], ['/usuarios', 'GET', 's=' + tP], ['/nuevo', 'GET', 's=' + tP],
            ['/alta', 'POST', 's=' + tP + '&nombre=' + largo + '&pin=1234&cedula=123456789012345'],
            ['/usuario', 'GET', 's=' + tP + '&n=' + largo], ['/cambiar', 'POST', 's=' + tP + '&nombre=' + largo + '&a=pin&pin=1'],
            ['/contadores', 'GET', 's=' + tP], ['/ajustes', 'GET', 's=' + tP], ['/ajuste', 'POST', 's=' + tP + '&a=modo'],
            ['/ajuste', 'POST', 's=' + tP + '&a=minutos&minutos=7'], ['/pinadmin', 'POST', 's=' + tP + '&actual=1'],
            ['/copia', 'GET', 's=' + tP],
            ['/importar', 'GET', 's=' + tP], ['/estilo.css', 'GET', ''], ['/estilo2.css', 'GET', ''],
            ['/lista.js', 'GET', ''], ['/contadores.js', 'GET', ''], ['/csv.js', 'GET', ''], ['/copia-bajar.js', 'GET', ''], ['/copia-subir.js', 'GET', ''], ['/subir.js', 'GET', ''],
        ];
        const nocaben = peores.map(([r, m, b]) => [r + ' ' + m, pedir(r, m, b).body])
            .filter(([, cuerpo]) => /no cabe en lo que la impresora/.test(cuerpo) || web.bytesUtf8(cuerpo) > config.WEB_MAX_BYTES)
            .map(([r]) => r);
        sesion.cerrar('prueba');
        check('todas las páginas caben en su peor caso', nocaben.length === 0, nocaben.join(', '));
    }

    check('la ruta /eco describe la petición', /campos=/.test(pedir('/eco', 'GET').body));
    check('anota la petición en el diagnóstico', web.informe().join(' ').includes('app_notify'), web.informe().join(' | '));
    delete mock.pedk.net.http.Response;
    check('sin Response en el firmware no se engancha y lo dice', !web.instalar().ok);
}

hablar();
console.log('\n' + ok + ' bien, ' + fallos + ' mal\n');
if (fallos > 0) {
    console.log('--- consola de la app ---\n' + consola.slice(-40).join('\n'));
}
process.exit(fallos > 0 ? 1 : 0);
