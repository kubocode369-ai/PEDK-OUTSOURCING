// Vista previa del panel web con datos de ejemplo, SIN impresora: npm test (genera .build/)
// y luego  node test/vista.mjs  -> http://localhost:8123/pedk/app_notify/vizo/ (PIN 2580).
import http from 'http';
import { makePedk } from './mock-pedk.mjs';
globalThis.pedk = makePedk({ retencion: { KuboC: [] } }).pedk;
const store = await import('./.build/store.mjs'); store._recargar();
const web = await import('./.build/web.mjs');
const acciones = await import('./.build/acciones.mjs');
console.log = ((o) => (...a) => { if (!String(a[0]).startsWith('[')) o(...a); })(console.log);
web.instalar();
[['cc','Carlos Cueva','1721653232'],['ef','Eduardo Flores',''],['rl','Ricardo López','0912345678'],['rm','Richard Macas','1719146399'],['mgomez','María Gómez Núñez','']]
  .forEach(([n, c, d]) => store.agregarUsuario(n, '1234', { nombreCompleto: c, cedula: d }));
store.activarUsuario('ef', false);
[['cc', 12], ['rl', 5], ['rm', 30]].forEach(([n, p]) => store.contar(n, { tipo: 'PRINT', paginas: p }));
store.contar('rm', { tipo: 'COPY', paginas: 4 });
acciones.fijarModo('retencion'); acciones.fijarBloqueo(true); store.cambiarAjuste('bloquearCopia', true);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const r = pedk.net.http.receiveData({ url: req.url, method: req.method, body });
    res.writeHead(r.code, Object.assign({ 'Content-Type': r.headers.v }, r.headers.extra));
    res.end(r.body);
  });
}).listen(8123, () => {
  const b = pedk.net.http.receiveData({ url: '/pedk/app_notify/vizo/entrar', method: 'POST', body: 'pin=2580' }).body;
  console.log('TOKEN ' + /[?]s=([0-9a-f]+)/.exec(b)[1]);
});
