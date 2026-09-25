# -*- coding: utf-8 -*-
"""Genera el logo de Vizo para el panel web, en PNG diminuto.

    python herramientas/hacer-logo-web.py "C:\\Users\\KuboC\\Desktop\\Vizo Logo.png"

Por qué tan pequeño: la impresora corta cualquier respuesta que pase de ~1998 bytes, y
cada fichero extra es una petición de 1,15 s. Así que el logo tiene que caber en una
respuesta y pesar lo menos posible.

La clave es la PALETA FIJA. Dejando que PIL elija los colores, el rojo y el gris del
logo se fundían en un morado feo (probado el 25-09-2026). Aquí se le imponen los dos
colores de la marca más unas mezclas con blanco para los bordes suaves.
"""
import os
import sys
from PIL import Image

ROJO = (193, 18, 47)
GRIS = (58, 64, 72)
BLANCO = (255, 255, 255)
ANCHO = 220          # como el logo de la web de Pantum, que es la referencia


def mezcla(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def paleta():
    """Blanco, los dos colores de marca y sus mezclas para que los bordes no dentellen."""
    colores = [BLANCO, ROJO, GRIS,
               mezcla(ROJO, BLANCO, 0.5), mezcla(GRIS, BLANCO, 0.5),
               mezcla(ROJO, BLANCO, 0.8), mezcla(GRIS, BLANCO, 0.8),
               mezcla(ROJO, GRIS, 0.5)]
    p = Image.new('P', (1, 1))
    datos = []
    for c in colores:
        datos.extend(c)
    p.putpalette(datos + [0, 0, 0] * (256 - len(colores)))
    return p


logo_png = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser('~'), 'Desktop', 'Vizo Logo.png')
destino = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logo-web.png')

src = Image.open(logo_png).convert('RGB')
logo = src.crop((296, 262, 1490, 592))       # la V y la palabra, sin aire alrededor
alto = int(logo.height * ANCHO / logo.width)
chico = logo.resize((ANCHO, alto), Image.LANCZOS)
final = chico.quantize(palette=paleta(), dither=Image.NONE)
final.save(destino, optimize=True)

n = os.path.getsize(destino)
print('%s  ·  %dx%d  ·  %d bytes%s' % (destino, ANCHO, alto, n,
                                       '  (CABE en una respuesta)' if n <= 1900 else '  ¡NO CABE!'))

# Vista ampliada para revisarlo a ojo.
previa = os.path.join(os.environ.get('TEMP', '.'), 'logo-web-previa.png')
final.convert('RGB').resize((ANCHO * 2, alto * 2), Image.NEAREST).save(previa)
print('previa: ' + previa)
