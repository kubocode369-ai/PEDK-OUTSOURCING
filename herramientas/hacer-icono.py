# -*- coding: utf-8 -*-
"""Genera el icono de la app para el panel de la impresora, a partir del logo de Vizo.

    python herramientas/hacer-icono.py "C:\\Users\\KuboC\\Desktop\\Vizo Logo.png"

El equipo pide un BMP de 88x146 (es la loseta entera del menú, no el dibujo). El icono
que traía de fábrica dejaba mucho aire alrededor del dibujo, y los iconos vecinos del
firmware (IM SGR, IM USB) son igual de discretos: por eso aquí sólo va la **V**, pequeña
y centrada, sobre blanco. La palabra "Vizo" NO se dibuja — el menú ya pone el nombre.
"""
import os
import sys
from PIL import Image

ANCHO, ALTO = 88, 146
ANCHO_MARCA = 46          # la V ocupa la mitad de la loseta, como los iconos vecinos

logo = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser('~'), 'Desktop', 'Vizo Logo.png')
salida = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      '..', 'resources', 'media', 'icon', 'app_icon.bmp')

src = Image.open(logo).convert('RGB')
marca = src.crop((300, 270, 728, 585))        # sólo la V, sin la palabra

ancho = ANCHO_MARCA
alto = int(marca.height * ancho / marca.width)
icono = Image.new('RGB', (ANCHO, ALTO), (255, 255, 255))
icono.paste(marca.resize((ancho, alto), Image.LANCZOS),
            ((ANCHO - ancho) // 2, (ALTO - alto) // 2))
icono.save(os.path.normpath(salida))

print('icono: %dx%d  ·  la V mide %dx%d  ·  %s'
      % (ANCHO, ALTO, ancho, alto, os.path.normpath(salida)))

# Vista ampliada para revisarlo a ojo, junto al que traía el equipo.
previa = os.path.join(os.environ.get('TEMP', '.'), 'icono-nuevo.png')
icono.resize((ANCHO * 2, ALTO * 2), Image.NEAREST).save(previa)
print('previa: ' + previa)
