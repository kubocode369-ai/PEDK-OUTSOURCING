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
    }
    setScreenBrightness() {}
}
class KeyCtrl { setCallBackFunc() {} }

export function makePedk(opts = {}) {
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
    const storage = {
        getUserDefinedData: () => JSON.parse(JSON.stringify(store)),
        setUserDefinedData: (d) => { store = JSON.parse(JSON.stringify(d)); },
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
        imprimir: agregar,
        pantalla: () => pantallaActual,
        textos: () => pantallaActual.filter((w) => w instanceof Label || w instanceof Button).map((w) => w.text).join(' | '),
        /** Pulsa el botón con ese id, o el primero cuyo texto sea exactamente ése. */
        pulsar: (idOTexto) => {
            const b = pantallaActual.filter((w) => w instanceof Button && w.id === idOTexto)[0]
                || pantallaActual.filter((w) => w instanceof Button && w.text === idOTexto)[0];
            if (!b) throw new Error('no hay botón "' + idOTexto + '" en: ' + pantallaActual.filter((w) => w instanceof Button).map((w) => w.id).join(','));
            b.cb_released();
        },
    };
}
