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
    silenciar();
    mock.pulsar('terminar');
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

hablar();
console.log('\n' + ok + ' bien, ' + fallos + ' mal\n');
if (fallos > 0) {
    console.log('--- consola de la app ---\n' + consola.slice(-40).join('\n'));
}
process.exit(fallos > 0 ? 1 : 0);
