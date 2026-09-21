/**
 * Simulador mínimo de `pedk` para ejecutar la app fuera del equipo.
 *
 * Imita la FORMA de la API medida en la BM5220ADW, no el firmware. Sirve para que
 * cada camino del código corra de verdad y salten los `TypeError` antes de gastar un
 * ciclo de firmar e instalar.
 *
 * Las clases de UI son de módulo (no por instancia): ui.js las toma una sola vez al
 * importarse, y el `instanceof` del ScreenCtrl tiene que reconocerlas en todos los casos.
 */
class StyleSheet {}
class Screen {}
class Label {}
class Button {}

let pantallaActual = [];

/**
 * Los listeners que el EQUIPO recuerda, en el orden en que se registraron.
 *
 * Medido en la BM5220ADW (Pedk1.log, 17-09-2026): `draw()` NO olvida los listeners de
 * las pantallas anteriores. El firmware guarda una lista global y, al tocar, la
 * recorre y dispara EL PRIMERO cuyo id coincida; en el log la lista todavía empieza
 * por los widgets del inicio dibujados un minuto antes, y contiene ids repetidos.
 *
 * Lo que el log NO aclara es qué hace al redibujar un id que ya está: si refresca su
 * callback o si deja ganando al viejo. Aquí se refresca, que es lo benigno. Así que
 * esta lista no es la red de seguridad: la red es la comprobación de que ninguna
 * pantalla comparte ids con otra (ver run.mjs). Con ids únicos el fallo no existe
 * bajo ninguna de las dos interpretaciones, y por eso el arreglo va por ahí.
 */
let listeners = [];

function registrar(widgets) {
    for (const w of widgets) {
        if (!(w instanceof Button)) continue;
        const previo = listeners.filter((l) => l.id === w.id)[0];
        if (previo) {
            previo.cb = w.cb_released;
        } else {
            listeners.push({ id: w.id, cb: w.cb_released });
        }
    }
}

class ScreenCtrl {
    draw(widgets) {
        if (!Array.isArray(widgets)) throw new Error('draw() sin lista');
        const ids = new Set();
        for (const w of widgets) {
            if (w === undefined || w === null) throw new Error('widget nulo en draw()');
            if (w instanceof Button || w instanceof Label) {
                for (const k of ['x', 'y', 'w', 'h']) {
                    if (typeof w[k] !== 'number' || Number.isNaN(w[k])) throw new Error('widget ' + w.id + ' sin ' + k);
                }
                if (w.x < 0 || w.y < 0 || w.x + w.w > 480 || w.y + w.h > 320) {
                    throw new Error('widget ' + w.id + ' fuera del panel 480x320');
                }
                if (ids.has(w.id)) throw new Error('id repetido: ' + w.id);
                ids.add(w.id);
            }
        }
        pantallaActual = widgets;
        registrar(widgets);
    }
    setScreenBrightness() {}
}
class KeyCtrl { setCallBackFunc() {} }

export function makePedk(opts = {}) {
    // Ni la pantalla ni los listeners se borran al cambiar de equipo simulado: el
    // recorrido del panel cambia el equipo bajo los pies de una app que sigue viva, y
    // es justo lo que pasa en la impresora (la app no se reinicia con cada trabajo).

    /* ---- interruptores ---- */
    const exportados = opts.exportados || ['FUNC_T_NET_PRINT', 'FUNC_T_USBPORT_PRINT', 'FUNC_T_COPY',
        'FUNC_T_IDCOPY', 'FUNC_T_BILL', 'FUNC_T_SECURE_PRINT'];
    const FUNCTION_TYPE = {};
    exportados.forEach((n) => { FUNCTION_TYPE[n] = n; });
    const switches = {};
    exportados.forEach((n) => { switches[n] = 'FUNC_SW_ON'; });
    const ignora = new Set(opts.ignora || []);        // acepta la llamada y no cambia nada
    const rechaza = new Set(opts.rechaza || []);      // lanza EOPNOTSUPP

    const setting = {
        FUNCTION_TYPE,
        FUNCTION_SWITCH: { FUNC_SW_ON: 'FUNC_SW_ON', FUNC_SW_OFF: 'FUNC_SW_OFF' },
        getFunctionSwitch: (k) => {
            if (!(k in switches)) return 'EINVALIDPARAM';
            return switches[k];
        },
        setFunctionSwitch: (k, v) => {
            if (rechaza.has(k)) throw new TypeError('EOPNOTSUPP');
            if (!ignora.has(k) && k in switches) switches[k] = v;
            return 'EXIT_SUCCESS';
        },
    };

    /* ---- memoria ---- */
    let store = opts.store ? JSON.parse(JSON.stringify(opts.store)) : {};
    /**
     * `memoriaFalla` imita a un equipo que no deja leer al arrancar, que es lo que
     * borraba a los usuarios: 'lanza' tira una excepción y 'error' devuelve un ERROR_NO
     * (String), que es lo que la doc del SDK dice que devuelven estas funciones cuando
     * fallan. Se desactiva con `mock.memoriaResponde()`, como si despertara.
     */
    let memoriaFalla = opts.memoriaFalla || null;
    const storage = {
        /**
         * Devuelve un STRING, como la BM5220ADW de verdad (medido 17-09-2026: `""` con
         * la memoria vacía, no un objeto como promete la doc). El mock devolvía un
         * objeto y por eso las pruebas no vieron nunca que la app no podía releer sus
         * propios datos. Con `uddObjeto` se imita lo que dice la doc, para que la app
         * aguante las dos formas.
         */
        getUserDefinedData: () => {
            if (memoriaFalla === 'lanza') throw new Error('storage not ready');
            if (memoriaFalla === 'error') return 'ERROR_NO_DEVICE_BUSY';
            if (opts.uddObjeto) return JSON.parse(JSON.stringify(store));
            if (Object.keys(store).length === 0) return '';
            const s = JSON.stringify(store);
            // Tope de tamaño: el equipo devolvió el JSON CORTADO A MEDIAS (medido el
            // 18-09-2026). Con `uddTope` se reproduce, para comprobar que la app no
            // pierde los datos por ello: el fichero de Object.save es quien manda.
            return opts.uddTope && s.length > opts.uddTope ? s.slice(0, opts.uddTope) : s;
        },
        setUserDefinedData: (d) => {
            store = JSON.parse(JSON.stringify(d));
            return 'EXIT_SUCCESS';
        },
    };

    /**
     * `Object.save`/`Object.load`, que en este equipo SÍ funcionan (ida y vuelta
     * comprobada). Devuelven basura igual que el equipo, para que nadie se apoye en
     * el retorno. Los ficheros viven en el mock, no en el disco.
     */
    let ficheros = opts.ficheros ? JSON.parse(JSON.stringify(opts.ficheros)) : {};
    /**
     * `Object.save`/`Object.load` son GLOBALES, así que se los queda el último equipo
     * creado. En una prueba que maneja dos equipos a la vez hay que volver a poner los
     * del que toque: para eso está `mock.activar()`.
     */
    const activar = () => {
        if (opts.sinObjectSave) {
            delete Object.save;
            delete Object.load;
            return;
        }
        Object.save = (nombre, obj) => {
            ficheros[String(nombre)] = JSON.stringify(obj);
            return -4.418332059740763e-95;
        };
        Object.load = (nombre) => {
            const s = ficheros[String(nombre)];
            if (s === undefined) throw new Error('no such file: ' + nombre);
            return JSON.parse(s);
        };
    };
    activar();

    /**
     * `pedk.net.http`, para el respaldo. El callback se llama EN EL ACTO y no en otra
     * vuelta del bucle: así las pruebas leen el resultado sin esperas. `error` llega
     * con "200 OK" también cuando va bien, como dice la doc del SDK — por eso la app
     * mira `resp.code` y no si `error` está vacío.
     *
     * `opts.red` manda: {respuestas: {'/ruta': {code, body}}, caida: true}
     */
    const peticiones = [];
    const red = {
        http: {
            Headers: function (k, v) { this.k = k; this.v = v; },
            Response: function (code, headers, body) { this.code = code; this.headers = headers; this.body = body; },
            receiveData: function () {},
            RequestBody: function (data) { this.data = data; },
            Request: function (url, method, headers, body) {
                this.url = url; this.method = method; this.headers = headers; this.body = body;
            },
            fetchData: (req, cb) => {
                peticiones.push({ url: req.url, method: req.method, cuerpo: req.body && req.body.data });
                const conf = opts.red || {};
                if (conf.caida) {
                    cb('Connection refused', null);
                    return 'EXIT_SUCCESS';
                }
                const ruta = String(req.url).replace(/^http:\/\/[^/]*/, '');
                const r = (conf.respuestas && conf.respuestas[ruta]) || { code: 200, body: {} };
                cb('200 OK', { code: r.code, body: r.body, headers: null });
                return 'EXIT_SUCCESS';
            },
        },
    };

    /* ---- historial, con la forma leída del equipo ---- */
    let seq = opts.primerId || 110;
    const historial = [];
    const dosDigitos = (n) => String(n).padStart(2, '0');
    const ahoraTexto = () => {
        const d = new Date();
        return d.getFullYear() + '-' + dosDigitos(d.getMonth() + 1) + '-' + dosDigitos(d.getDate())
            + ' ' + dosDigitos(d.getHours()) + ':' + dosDigitos(d.getMinutes()) + ':' + dosDigitos(d.getSeconds());
    };
    const agregar = ({ tipo = 'PRINT', paginas = 1, estado = 'COMPLETED', host = '', hora, id } = {}) => {
        // id explícito (más bajo) imita un trabajo viejo que aflora al activar el registro.
        const jobId = id !== undefined ? id : ++seq;
        historial.push({
            job_id: String(jobId),
            start_time: hora || ahoraTexto(),
            type: 'JOB_HISTORY_TYPE_' + tipo,
            status: 'JOB_HISTORY_STATUS_' + estado,
            user_name: 'Admin',
            host_name: host,
            filename: '-',
            param: { copies: '1', pages: String(paginas), duplex: 'SINGLE', color: 'MONO' },
        });
    };
    (opts.historialPrevio || []).forEach(agregar);
    /* ---- trabajos en curso (forma del SDK: JobInfo con getters) ---- */
    const enCurso = [];
    const oyentes = [];
    const cancelados = [];
    const infoDe = (t) => ({
        getJobId: () => t.id, getWoNum: () => t.wo, getJobType: () => t.tipo,
        getJobState: () => t.estado, getUserName: () => t.usuario || '', getDocumentName: () => t.doc || '',
        getPrintPageNum: () => t.hechas || 0, getPrintPageTotalNum: () => t.paginas || 0,
    });
    const jobctl = {
        getJobHistoryList: () => historial.map((e) => ({ ...e, param: { ...e.param } })),
        getJobLastHistory: () => historial[historial.length - 1] || null,
        JobListener: class { notify() {} },
        addJobListener: (l) => { oyentes.push(l); return true; },
        getJobList: () => enCurso.map(infoDe),
        cancelJob: (id) => {
            const i = enCurso.findIndex((t) => t.id === id);
            if (i < 0) return false;
            cancelados.push(id);
            enCurso.splice(i, 1);
            return true;
        },
    };
    /** Llega un trabajo (o cambia de estado) y se avisa a los oyentes. */
    const llegaTrabajo = (t) => {
        const previo = enCurso.find((x) => x.id === t.id);
        if (previo) Object.assign(previo, t); else enCurso.push({ wo: t.id + 1000, ...t });
        const actual = enCurso.find((x) => x.id === t.id) || t;
        oyentes.forEach((l) => l.notify(infoDe(actual)));
    };

    /*
     * ---- impresión segura, con la forma leída del firmware (Explorar SDK, 16-09-2026) ----
     * La base nativa devuelve TEXTO con comas; la clase oficial sobrescribe setJobId con
     * una trampa que lanza "not a function", y la parte nativa la pisa al construir.
     */
    const print = { PrintParameterSet: class {} };
    const liberados = [];
    if (opts.retencion) {
        // {dueño (usuario de Windows): [{doc (Nombre del driver, numerado), pin}]}
        const r = opts.retencion;
        const lista = (s) => '[' + s.map((x) => '"' + x + '"').join(',') + ']';
        const visibles = (dueno, pin) => (r[dueno] || []).filter((t) => t.pin === pin);
        class PesfPrintJob {
            constructor() { this.idNativo = 0; }
            setJobId(id) { this.idNativo = id; }
            getJobId() { return this.idNativo; }
            EncryptJobPrint() {
                if (opts.retencionRota) throw new Error('EXIT_FAILURE');
                this.setJobId(0);
            }
            getUserNameList() { return lista(Object.keys(r).filter((k) => r[k].length > 0)); }
            getEncryptJobList(dueno, pin) { return lista(visibles(dueno, pin).map((t) => t.doc)); }
            EncryPrint_start(no, param, cuota, dueno, doc) {
                const i = (r[dueno] || []).findIndex((t) => t.doc === doc);
                if (i < 0) return -1;
                liberados.push(doc);
                r[dueno].splice(i, 1);
                return -2.2093146182312478e-95;   // lo que devolvió el equipo el 16-09-2026, e imprimió
            }
        }
        class EncryptJobPrint extends PesfPrintJob {
            constructor() {
                super();
                super.EncryptJobPrint();
            }
            setJobId() { throw TypeError('not a function'); }
            getEncryptJobList(dueno, pin) {
                this.nombreJs = dueno;
                const s = super.getEncryptJobList(dueno, pin);
                this.docsJs = s.split(',').map((x) => x.replace(/[\[\]"]/g, ''));
                return s;
            }
            start(no, param, cuota) {
                if (typeof no !== 'number' || typeof param !== 'object' || typeof cuota !== 'object') return 'PARAM_ERROR';
                return super.EncryPrint_start(no, param, cuota, this.nombreJs, this.docsJs[no]) === -1 ? 'INTERNAL_DEFICIENCY' : 'SUCCESS';
            }
        }
        print.EncryptJobPrint = EncryptJobPrint;
    }

    const pedk = {
        ui: { widget: { Screen, Label, Button, StyleSheet }, ScreenCtrl, KeyCtrl },
        device: { setting, storage, powersave: { getCurrentState: () => 0 } },
        net: red,
        jobctl,
        jobs: { print },
    };

    return {
        pedk,
        switches,
        liberados,
        cancelados,
        llegaTrabajo,
        getStore: () => store,
        /** Los ficheros de Object.save, tal como quedaron. */
        getFicheros: () => ficheros,
        /** Las peticiones HTTP que hizo la app: [{url, method, cuerpo}]. */
        peticiones: () => peticiones,
        /** Vuelve a poner los Object.save/load de ESTE equipo (son globales). */
        activar,
        /** El equipo vuelve a dejar leer la memoria (como si hubiera despertado). */
        memoriaResponde: () => { memoriaFalla = null; },
        /** Borra sólo los ficheros: imita una reinstalación si no sobreviven. */
        borrarFicheros: () => { ficheros = {}; },
        imprimir: agregar,
        pantalla: () => pantallaActual,
        textos: () => pantallaActual.filter((w) => w instanceof Label || w instanceof Button).map((w) => w.text).join(' | '),
        /** Ids de los botones visibles ahora mismo. */
        botones: () => pantallaActual.filter((w) => w instanceof Button).map((w) => w.id),
        /**
         * Toca un botón como lo haría una persona: se elige entre los VISIBLES (por id
         * completo, por id sin el prefijo de ámbito, o por texto exacto) y luego se
         * dispara a quien llamaría el equipo: el primer listener con ese id.
         *
         * Si el id del botón visible está pisado por otra pantalla, aquí se ejecuta el
         * callback de la otra: exactamente el fallo del equipo.
         */
        pulsar: (sel) => {
            const visibles = pantallaActual.filter((w) => w instanceof Button);
            const porId = visibles.filter((w) => w.id === sel);
            const porSufijo = visibles.filter((w) => w.id.endsWith('_' + sel));
            const porTexto = visibles.filter((w) => w.text === sel);
            const cand = porId.length ? porId : porSufijo.length ? porSufijo : porTexto;
            if (cand.length === 0) {
                throw new Error('no hay botón "' + sel + '" en: ' + visibles.map((w) => w.id).join(','));
            }
            if (cand.length > 1) {
                throw new Error('botón "' + sel + '" ambiguo: ' + cand.map((w) => w.id).join(','));
            }
            const l = listeners.filter((x) => x.id === cand[0].id)[0];
            (l ? l.cb : cand[0].cb_released)();
        },
    };
}
