/**
 * Crea el GENERADOR DE CÓDIGOS de Soprint: una página que se abre con doble clic (en
 * el PC o en el móvil, sin instalar nada) y calcula el código que restablece el PIN de
 * admin de Vizo en un equipo. Lo llama `npm run build`.
 *
 * La página lleva DENTRO la clave de sign/rescate.key, así que es CONFIDENCIAL: sólo
 * para el personal de Soprint, nunca a un cliente ni por correo abierto. Por eso se
 * escribe en build/, que no va al repositorio.
 *
 * La cuenta es la de la app, copiada tal cual de src/sha256.js y src/codigoRescate.js
 * (sin import/export): no hay una segunda versión que pueda desviarse.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SALIDA = join(raiz, 'build', 'Generador de codigos Vizo.html');

/** El JavaScript de la cuenta, sin módulos: define `respuesta` y `enGrupos`. */
export function scriptCalculo() {
    const limpiar = (f) => readFileSync(join(raiz, 'src', f), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^export (const|function) /gm, '$1 ');
    return limpiar('sha256.js') + '\n' + limpiar('codigoRescate.js');
}

export function construir(clave) {
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generador de códigos Vizo</title>
<style>
  :root { --rojo: #c1122f; --gris: #3a4048; --borde: #d0d4d9; --fondo: #f4f5f7; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--gris);
         font: 16px/1.45 "Segoe UI", Arial, sans-serif; }
  header { background: #fff; border-bottom: 3px solid var(--rojo); padding: 14px 16px; text-align: center; }
  header b { font: 900 26px "Arial Black", Arial, sans-serif; letter-spacing: .5px; }
  header b i { color: var(--rojo); font-style: normal; }
  header span { display: block; font-size: 14px; }
  main { max-width: 440px; margin: 20px auto; padding: 0 16px; }
  .caja { background: #fff; border: 1px solid var(--borde); border-radius: 10px; padding: 20px; }
  label { display: block; font-weight: 600; margin: 14px 0 6px; }
  label:first-child { margin-top: 0; }
  input { width: 100%; font: 600 24px Consolas, monospace; letter-spacing: 2px; padding: 10px 12px;
          border: 2px solid var(--borde); border-radius: 8px; text-transform: uppercase; }
  input:focus { outline: none; border-color: var(--rojo); }
  small { color: #6b7280; }
  button { width: 100%; margin-top: 18px; padding: 14px; font-family: inherit; font-weight: 700; font-size: 18px;
           color: #fff; background: var(--rojo); border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  #res { display: none; margin-top: 20px; text-align: center; border-top: 1px solid var(--borde); padding-top: 16px; }
  #codigo { font: 700 52px Consolas, monospace; letter-spacing: 4px; color: var(--rojo); }
  #copiar { background: var(--gris); font-size: 15px; padding: 10px; margin-top: 8px; }
  #error { display: none; margin-top: 14px; color: var(--rojo); font-weight: 600; }
  .aviso { margin-top: 16px; font-size: 14px; background: #fff7e6; border: 1px solid #f3d19c;
           border-radius: 8px; padding: 12px; }
</style>
</head>
<body>
<header><b>V<i>i</i>zo</b><span>Generador de códigos · Restablecer PIN de administrador</span></header>
<main>
  <div class="caja">
    <label for="serie">Número de serie del equipo</label>
    <input id="serie" autocomplete="off" placeholder="CV3DV0004X" maxlength="32">
    <label for="sol">Solicitud</label>
    <input id="sol" inputmode="numeric" autocomplete="off" placeholder="000 000" maxlength="7">
    <small>Los dos datos salen en la pantalla de la impresora.</small>
    <button id="calcular">Calcular código</button>
    <div id="error"></div>
    <div id="res">
      <div>Díctele al cliente este código:</div>
      <div id="codigo"></div>
      <button id="copiar">Copiar</button>
    </div>
  </div>
  <div class="aviso"><b>Antes de dar el código</b>, confirme quién llama: empresa cliente, persona y
    número de serie. El código devuelve el PIN de administrador a <b>2580</b> y el cliente debe
    cambiarlo después.<br><br><b>Archivo confidencial de Soprint:</b> no lo envíe a clientes.</div>
</main>
<script>
${scriptCalculo()}
const CLAVE = ${JSON.stringify(clave)};
const $ = (id) => document.getElementById(id);
function calcular() {
  const serie = $('serie').value.trim().toUpperCase();
  const sol = $('sol').value.replace(/\\D/g, '');
  $('res').style.display = 'none';
  $('error').style.display = 'none';
  let fallo = '';
  if (!/^[A-Z0-9-]{4,32}$/.test(serie)) fallo = 'Escriba el número de serie tal como sale en la pantalla.';
  else if (sol.length !== 6) fallo = 'La solicitud tiene 6 cifras.';
  if (fallo) { $('error').textContent = fallo; $('error').style.display = 'block'; return; }
  $('codigo').textContent = enGrupos(respuesta(CLAVE, serie, sol));
  $('res').style.display = 'block';
}
$('calcular').onclick = calcular;
['serie', 'sol'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') calcular(); }));
$('copiar').onclick = () => {
  const t = $('codigo').textContent.replace(/\\s/g, '');
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
    () => { $('copiar').textContent = 'Copiado'; setTimeout(() => { $('copiar').textContent = 'Copiar'; }, 1500); },
    () => {});
};
$('serie').focus();
</script>
</body>
</html>
`;
}

function principal() {
    const f = join(raiz, 'sign', 'rescate.key');
    if (!existsSync(f)) {
        console.error('Falta sign/rescate.key: no se crea el generador.');
        process.exit(1);
    }
    mkdirSync(dirname(SALIDA), { recursive: true });
    writeFileSync(SALIDA, construir(readFileSync(f, 'utf8').trim()));
    console.log('generador: ' + SALIDA);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    principal();
}
