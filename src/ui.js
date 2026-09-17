/**
 * Ayudas para dibujar en el panel (480x320). Las pantallas se arman enteras en cada
 * pintado, como en las apps que ya funcionan en el equipo.
 *
 * El teclado de texto se construye con botones y no con `LineEdit` + teclado del
 * sistema: `Button` está probado en el equipo y `LineEdit` no se ha usado nunca en
 * él. Un widget sin probar en la pantalla de entrada es la peor apuesta posible.
 */
import { guard } from './guard.js';

const { Screen, Label, Button, StyleSheet } = pedk.ui.widget;

export const COLOR = {
    texto: '#1c1e23',
    suave: '#64656B',
    tenue: '#8a8d94',
    acento: '#288AE1',
    ok: '#1a9c53',
    aviso: '#d98a00',
    peligro: '#c8102e',
};

/**
 * ÁMBITO DE IDS. Medido en la BM5220ADW (17-09-2026, Pedk1.log): el firmware NO
 * olvida los listeners de las pantallas anteriores. Guarda una lista global y, al
 * tocar, la recorre y dispara EL PRIMERO cuyo id coincida. En el log se ve cómo,
 * estando en "Nuevo usuario", la lista empieza por los widgets de la pantalla de
 * inicio (`estado`, `paso0`, `paso1`) dibujados un minuto antes.
 *
 * Consecuencia: dos pantallas con un mismo id se pisan para siempre. El "Siguiente"
 * de Ajustes > Nuevo usuario ejecutaba el "Siguiente" del login (mismo id `seguir`,
 * registrado antes), que validaba un usuario vacío y volvía atrás: la pantalla del
 * PIN no llegaba a abrirse nunca.
 *
 * Por eso cada pantalla declara su ámbito como PRIMERA línea de su render, y aquí se
 * le pega a cada id. Los ids quedan únicos en toda la app, no sólo dentro de una
 * pantalla. La prueba del panel lo comprueba (mock-pedk imita esta lista global).
 */
let prefijo = '';

export function ambito(nombre) {
    prefijo = nombre ? nombre + '_' : '';
}

function idDe(id) {
    return prefijo + id;
}

export function pantalla() {
    return new Screen();
}

export function etiqueta(id, x, y, w, h, texto, color, alineacion) {
    const l = new Label();
    l.id = idDe(id);
    l.x = x; l.y = y; l.w = w; l.h = h;
    l.text = texto === null || texto === undefined ? '' : String(texto);
    l.style_sheet = new StyleSheet();
    l.style_sheet.text_color = color || COLOR.texto;
    l.style_sheet.text_align = alineacion || 'left';
    l.style_sheet.text_direction = 'ltr';
    return l;
}

export function boton(id, x, y, w, h, texto, color, alPulsar) {
    const b = new Button();
    b.id = idDe(id);
    b.x = x; b.y = y; b.w = w; b.h = h;
    b.text = texto === null || texto === undefined ? '' : String(texto);
    b.style_sheet = new StyleSheet();
    b.style_sheet.text_align = 'center';
    b.style_sheet.text_color = color || COLOR.texto;
    b.cb_released = guard(b.id, alPulsar);
    return b;
}

export function recortar(texto, max) {
    if (!texto) {
        return '';
    }
    const s = String(texto);
    return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

/** Teclado numérico 3x4 con C (borrar) y OK. */
export function tecladoNumerico(prefijo, x, y, alTecla) {
    const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    const w = 92;
    const h = 38;
    return teclas.map((t, i) => boton(prefijo + '_' + t,
        x + (i % 3) * (w + 8), y + Math.floor(i / 3) * (h + 4), w, h, t,
        t === 'OK' ? COLOR.ok : t === 'C' ? COLOR.peligro : COLOR.texto,
        () => alTecla(t)));
}

/**
 * Teclado de texto para el nombre de usuario: minúsculas, dígitos y . _ -
 * Diez columnas de 44 px (el panel mide 480). La tecla '<' borra la última letra.
 */
const FILAS_TEXTO = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '<'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '_', '-'],
];

export function tecladoTexto(prefijo, y, alTecla) {
    const out = [];
    const w = 44;
    const h = 36;
    FILAS_TEXTO.forEach((fila, f) => {
        fila.forEach((t, c) => {
            out.push(boton(prefijo + '_' + f + '_' + c, 2 + c * (w + 4), y + f * (h + 4), w, h, t,
                t === '<' ? COLOR.peligro : COLOR.texto, () => alTecla(t)));
        });
    });
    return out;
}

/** Trozo de una lista para paginar. */
export function paginar(lista, pagina, porPagina) {
    const total = lista ? lista.length : 0;
    const paginas = Math.max(1, Math.ceil(total / porPagina));
    const actual = Math.min(Math.max(0, pagina), paginas - 1);
    const desde = actual * porPagina;
    return {
        items: (lista || []).slice(desde, desde + porPagina),
        pagina: actual,
        paginas,
        total,
    };
}

/** Botones Ant./Sig.; sólo aparecen con más de una página. */
export function paginador(id, x, y, info, alAnterior, alSiguiente) {
    if (info.paginas <= 1) {
        return [];
    }
    return [
        boton(id + '_ant', x, y, 92, 30, '< Ant.', info.pagina > 0 ? COLOR.acento : COLOR.tenue, alAnterior),
        boton(id + '_sig', x + 98, y, 92, 30, 'Sig. >',
            info.pagina < info.paginas - 1 ? COLOR.acento : COLOR.tenue, alSiguiente),
        etiqueta(id + '_n', x + 198, y + 5, 80, 20, (info.pagina + 1) + '/' + info.paginas, COLOR.tenue),
    ];
}
