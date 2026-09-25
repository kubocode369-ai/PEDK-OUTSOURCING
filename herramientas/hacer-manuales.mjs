/**
 * Convierte los manuales de `doc/*.md` en PDF listos para imprimir y entregar.
 *
 *     node herramientas/hacer-manuales.mjs
 *
 * No hay dependencias nuevas: el Markdown que escribimos es sencillo y predecible
 * (títulos, tablas, listas, citas, código y negritas), así que se traduce aquí mismo, y
 * el PDF lo hace el Chrome que ya está instalado, como en `test/vista.mjs`.
 *
 * Los PDF quedan en `doc/pdf/`. Están pensados para papel A4: encabezado con el nombre
 * del documento, número de página, y las tablas y los títulos sin partirse a la mitad.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, '..');
const origen = join(raiz, 'doc');
const destino = join(origen, 'pdf');
const temporal = join(raiz, '.tmp', 'manuales');

const NAVEGADORES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

/* ------------------------------------------------------------------ */
/* Markdown -> HTML                                                     */
/* ------------------------------------------------------------------ */

function escapar(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Lo de dentro de una línea: `código`, **negrita**, *cursiva*, [enlace](destino). */
function enLinea(t) {
    return escapar(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // La cursiva va DESPUÉS de la negrita: si no, se comería sus asteriscos.
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function fila(linea, celda) {
    const partes = linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return '<tr>' + partes.map((c) => '<' + celda + '>' + enLinea(c.trim()) + '</' + celda + '>').join('') + '</tr>';
}

function aHtml(md) {
    const lineas = md.split(/\r?\n/);
    const out = [];
    let i = 0;
    /** Listas abiertas, de fuera adentro: [{tipo, sangria}]. */
    const pila = [];

    const cerrarLista = () => {
        while (pila.length) {
            out.push('</' + pila.pop().tipo + '>');
        }
    };

    while (i < lineas.length) {
        const l = lineas[i];

        // Bloque de código
        if (/^```/.test(l)) {
            cerrarLista();
            const cuerpo = [];
            i++;
            while (i < lineas.length && !/^```/.test(lineas[i])) {
                cuerpo.push(escapar(lineas[i]));
                i++;
            }
            i++;
            out.push('<pre>' + cuerpo.join('\n') + '</pre>');
            continue;
        }

        // Tabla: cabecera, separador, filas
        if (/^\|/.test(l) && /^\|[\s:|-]+\|$/.test(lineas[i + 1] || '')) {
            cerrarLista();
            out.push('<table>', '<thead>' + fila(l, 'th') + '</thead>', '<tbody>');
            i += 2;
            while (i < lineas.length && /^\|/.test(lineas[i])) {
                out.push(fila(lineas[i], 'td'));
                i++;
            }
            out.push('</tbody></table>');
            continue;
        }

        const titulo = /^(#{1,4})\s+(.*)$/.exec(l);
        if (titulo) {
            cerrarLista();
            const n = titulo[1].length;
            out.push('<h' + n + '>' + enLinea(titulo[2]) + '</h' + n + '>');
            i++;
            continue;
        }

        if (/^---+$/.test(l.trim())) {
            cerrarLista();
            out.push('<hr>');
            i++;
            continue;
        }

        if (/^>\s?/.test(l)) {
            cerrarLista();
            const cuerpo = [];
            while (i < lineas.length && /^>\s?/.test(lineas[i])) {
                cuerpo.push(lineas[i].replace(/^>\s?/, ''));
                i++;
            }
            out.push('<blockquote>' + enLinea(cuerpo.join(' ')) + '</blockquote>');
            continue;
        }

        const marca = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(l);
        if (marca) {
            const sangria = marca[1].length;
            const quiero = /^\s*[-*]\s/.test(l) ? 'ul' : 'ol';
            // Una sublista NO cierra la de arriba: si se cerrara, la numeración del
            // punto siguiente volvería a empezar en 1 (pasó en el manual de usuario).
            while (pila.length && pila[pila.length - 1].sangria > sangria) {
                out.push('</' + pila.pop().tipo + '>');
            }
            const arriba = pila[pila.length - 1];
            if (!arriba || arriba.sangria < sangria || arriba.tipo !== quiero) {
                if (arriba && arriba.sangria === sangria && arriba.tipo !== quiero) {
                    out.push('</' + pila.pop().tipo + '>');
                }
                out.push('<' + quiero + '>');
                pila.push({ tipo: quiero, sangria });
            }
            // Casillas de verificación: cuadros para marcar a mano.
            const casilla = /^\[ \]\s*/.test(marca[2]);
            const texto = enLinea(marca[2].replace(/^\[ \]\s*/, ''));
            out.push('<li>' + (casilla ? '<span class="casilla"></span>' : '') + texto + '</li>');
            i++;
            continue;
        }

        // Línea sangrada que continúa el punto anterior (no es otro punto).
        if (pila.length && /^\s{2,}\S/.test(l)) {
            const ultimo = out.pop();
            out.push(ultimo.replace(/<\/li>$/, ' ' + enLinea(l.trim()) + '</li>'));
            i++;
            continue;
        }

        if (l.trim() === '') {
            cerrarLista();
            i++;
            continue;
        }

        // Párrafo: junta las líneas seguidas.
        const parrafo = [];
        while (i < lineas.length && lineas[i].trim() !== '' && !/^[#>|`-]/.test(lineas[i])
            && !/^\s*\d+\.\s/.test(lineas[i])) {
            parrafo.push(lineas[i].trim());
            i++;
        }
        if (parrafo.length) {
            cerrarLista();
            out.push('<p>' + enLinea(parrafo.join(' ')) + '</p>');
        } else {
            i++;
        }
    }
    cerrarLista();
    return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* La página, pensada para papel                                        */
/* ------------------------------------------------------------------ */

const ESTILO = `
@page { size: A4; margin: 18mm 16mm 16mm 16mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 Arial, Helvetica, sans-serif; color: #222; margin: 0; }
h1 { font-size: 20pt; color: #BB0033; margin: 0 0 4mm; border-bottom: 2px solid #BB0033; padding-bottom: 2mm; }
h2 { font-size: 13pt; color: #BB0033; margin: 7mm 0 2mm; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 5mm 0 1.5mm; break-after: avoid; }
p { margin: 0 0 2.5mm; }
ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
li { margin-bottom: 1.2mm; }
code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; background: #f2f2f2;
       padding: 0.3mm 1mm; border-radius: 2px; }
pre { font-family: Consolas, "Courier New", monospace; font-size: 9pt; background: #f7f7f7;
      border-left: 3px solid #BB0033; padding: 2.5mm 3mm; margin: 0 0 3mm; white-space: pre-wrap;
      break-inside: avoid; }
blockquote { margin: 0 0 3mm; padding: 2.5mm 3mm; background: #fff8e6; border-left: 3px solid #e0a800;
             break-inside: avoid; }
blockquote p { margin: 0; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3.5mm; font-size: 9.5pt; break-inside: avoid; }
th { background: #BB0033; color: #fff; text-align: left; padding: 1.8mm 2mm; font-weight: bold; }
td { border-bottom: 1px solid #ddd; padding: 1.8mm 2mm; vertical-align: top; }
tr:nth-child(even) td { background: #fafafa; }
hr { border: 0; border-top: 1px solid #ddd; margin: 5mm 0; }
a { color: #BB0033; }
.casilla { display: inline-block; width: 3.6mm; height: 3.6mm; border: 1px solid #888;
           margin-right: 1.5mm; vertical-align: -0.4mm; }
.pie { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #ddd; font-size: 8pt; color: #888; }
`;

function pagina(titulo, cuerpo, version) {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
        + '<title>' + escapar(titulo) + '</title><style>' + ESTILO + '</style></head><body>'
        + cuerpo
        + '<p class="pie">Impresión con PIN · Pantum BM5220ADW · ' + escapar(version) + '</p>'
        + '</body></html>';
}

/* ------------------------------------------------------------------ */

function navegador() {
    for (const ruta of NAVEGADORES) {
        if (existsSync(ruta)) {
            return ruta;
        }
    }
    throw new Error('no encuentro Chrome ni Edge para hacer los PDF');
}

function version() {
    try {
        const c = execFileSync('git', ['log', '-1', '--format=%h %ad', '--date=short'],
            { cwd: raiz, encoding: 'utf8' }).trim();
        return 'versión ' + c;
    } catch (e) {
        return new Date().toISOString().slice(0, 10);
    }
}

const chrome = navegador();
const v = version();
mkdirSync(destino, { recursive: true });
mkdirSync(temporal, { recursive: true });

const manuales = readdirSync(origen).filter((f) => f.endsWith('.md')).sort();
if (!manuales.length) {
    console.log('no hay manuales en doc/');
    process.exit(1);
}

for (const md of manuales) {
    const texto = readFileSync(join(origen, md), 'utf8');
    const titulo = (/^#\s+(.*)$/m.exec(texto) || [, basename(md, '.md')])[1];
    const html = join(temporal, basename(md, '.md') + '.html');
    const pdf = join(destino, basename(md, '.md') + '.pdf');
    writeFileSync(html, pagina(titulo, aHtml(texto), v), 'utf8');
    execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-pdf-header-footer',
        '--print-to-pdf=' + pdf, 'file:///' + html.replace(/\\/g, '/'),
    ], { stdio: 'pipe' });
    const kb = Math.round(readFileSync(pdf).length / 1024);
    console.log('  ' + basename(pdf) + '  (' + kb + ' KB)  ' + titulo);
}

// Con --html se queda el HTML intermedio, para mirarlo en el navegador o retocar estilo.
if (!process.argv.includes('--html')) {
    rmSync(temporal, { recursive: true, force: true });
} else {
    console.log('  (HTML en ' + temporal + ')');
}
console.log('\nListos en doc/pdf/ — ' + v);
