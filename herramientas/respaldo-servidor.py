#!/usr/bin/env python3
"""
Servidor de respaldo para la app "Impresión con PIN" (Pantum BM5220ADW).

Se lanza en un PC de la misma red que la impresora y atiende dos cosas:

  POST /respaldo       la impresora manda TODO (usuarios, huellas de PIN, contadores).
                       Se guarda en respaldos/respaldo-AAAAMMDD-HHMMSS.json, y también
                       como respaldos/ultimo.json para tenerlo siempre a mano.

  GET  /usuarios.json  la impresora lee de aquí la gente a dar de alta. Se sirve el
                       fichero usuarios.json de esta misma carpeta.

Por qué por red y no con una flash: la app NO puede leer ficheros de una flash USB.
Se midió en el equipo el 17-09-2026: del USB sólo se exponen interruptores.

    python herramientas/respaldo-servidor.py

Luego, en la impresora: Ajustes > Respaldo > Poner IP del PC, y se teclea la IP de
este PC (la que imprime este programa al arrancar).

AVISO IMPORTANTE. El respaldo lleva las huellas de los PIN. Una huella de un PIN de
4 dígitos se rompe probando las 10.000 combinaciones, así que la carpeta respaldos/
vale lo mismo que la lista de los PIN en claro: trátala igual que un fichero de
contraseñas. Este servidor no cifra nada y no pide credenciales; está pensado para una
red de oficina de confianza, no para exponerlo a internet.
"""

import json
import os
import socket
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

PUERTO = 8099                       # tiene que coincidir con config.RESPALDO_PUERTO
AQUI = os.path.dirname(os.path.abspath(__file__))
CARPETA_RESPALDOS = os.path.join(AQUI, 'respaldos')
FICHERO_USUARIOS = os.path.join(AQUI, 'usuarios.json')
LIMITE_BYTES = 4 * 1024 * 1024      # un respaldo real son unos pocos KB


def aviso(texto):
    """Imprime YA: sin flush, Python lo retiene cuando la salida no es una consola."""
    print(texto, flush=True)


def ahora():
    return datetime.now().strftime('%H:%M:%S')


def mi_ip():
    """La IP con la que este PC sale a la red, que es la que hay que teclear."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))   # no manda nada; sólo elige la interfaz
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


class Handler(BaseHTTPRequestHandler):
    def responder(self, codigo, cuerpo, tipo='application/json'):
        datos = cuerpo.encode('utf-8')
        self.send_response(codigo)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_POST(self):
        if self.path.rstrip('/') != '/respaldo':
            self.responder(404, '{"error":"ruta desconocida"}')
            return
        try:
            largo = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            largo = 0
        if largo <= 0 or largo > LIMITE_BYTES:
            aviso('  %s  respaldo rechazado: tamano %d' % (ahora(), largo))
            self.responder(400, '{"error":"tamano no valido"}')
            return

        crudo = self.rfile.read(largo)
        try:
            datos = json.loads(crudo.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as e:
            aviso('  %s  respaldo rechazado: no es JSON (%s)' % (ahora(), e))
            self.responder(400, '{"error":"no es JSON"}')
            return

        os.makedirs(CARPETA_RESPALDOS, exist_ok=True)
        sello = datetime.now().strftime('%Y%m%d-%H%M%S')
        destino = os.path.join(CARPETA_RESPALDOS, 'respaldo-%s.json' % sello)
        bonito = json.dumps(datos, indent=2, ensure_ascii=False)
        with open(destino, 'w', encoding='utf-8') as f:
            f.write(bonito)
        # Copia fija, para no tener que buscar cuál es el último.
        with open(os.path.join(CARPETA_RESPALDOS, 'ultimo.json'), 'w', encoding='utf-8') as f:
            f.write(bonito)

        usuarios = datos.get('usuarios') or []
        contadores = datos.get('contadores') or {}
        paginas = sum((c.get('paginas') or 0) + (c.get('paginasCopia') or 0)
                      for c in contadores.values() if isinstance(c, dict))
        aviso('  %s  RESPALDO de %s: %d usuario(s), %d pagina(s) contadas -> %s'
              % (ahora(), self.client_address[0], len(usuarios), paginas,
                 os.path.basename(destino)))
        self.responder(200, '{"ok":true}')

    def do_GET(self):
        ruta = self.path.split('?')[0].rstrip('/')
        if ruta not in ('/usuarios.json', '/usuarios'):
            self.responder(404, '{"error":"ruta desconocida"}')
            return
        if not os.path.exists(FICHERO_USUARIOS):
            aviso('  %s  pidieron usuarios.json y no existe' % ahora())
            self.responder(404, '{"error":"no hay usuarios.json en la carpeta"}')
            return
        try:
            with open(FICHERO_USUARIOS, encoding='utf-8') as f:
                datos = json.load(f)
        except (ValueError, OSError) as e:
            aviso('  %s  usuarios.json no se pudo leer: %s' % (ahora(), e))
            self.responder(500, '{"error":"usuarios.json no es JSON valido"}')
            return
        if isinstance(datos, list):
            cuantos = len(datos)
        elif isinstance(datos, dict) and isinstance(datos.get('usuarios'), list):
            cuantos = len(datos['usuarios'])
        else:
            cuantos = 0
        aviso('  %s  %s se lleva usuarios.json (%d usuario(s))'
              % (ahora(), self.client_address[0], cuantos))
        self.responder(200, json.dumps(datos, ensure_ascii=False))

    def log_message(self, formato, *args):
        pass        # se imprime lo interesante a mano, sin el ruido por defecto


def plantilla_usuarios():
    return {
        "_comentario": [
            "Lista de gente a dar de alta en la impresora.",
            "Cada usuario: nombre (minusculas, digitos y . _ -) y pin (4 a 8 digitos).",
            "En la impresora: Ajustes > Respaldo > Traer usuarios del PC.",
            "NO borra a nadie: crea los que falten y actualiza el PIN de los que ya estan.",
            "Para restaurar un respaldo, usa en su lugar respaldos/ultimo.json,",
            "que trae 'huella' y conserva los PIN que ya tenia cada persona."
        ],
        "usuarios": [
            {"nombre": "ana", "pin": "1234"},
            {"nombre": "luis", "pin": "4321"}
        ]
    }


def main():
    if not os.path.exists(FICHERO_USUARIOS):
        with open(FICHERO_USUARIOS, 'w', encoding='utf-8') as f:
            json.dump(plantilla_usuarios(), f, indent=2, ensure_ascii=False)
        aviso('Se creo una plantilla en %s' % FICHERO_USUARIOS)

    ip = mi_ip()
    aviso('')
    aviso('  Servidor de respaldo en marcha.')
    aviso('')
    aviso('    En la impresora, Ajustes > Respaldo > Poner IP del PC:   %s' % ip)
    aviso('    (el puerto %d ya lo sabe la app)' % PUERTO)
    aviso('')
    aviso('    Los respaldos se guardan en:  %s' % CARPETA_RESPALDOS)
    aviso('    Los usuarios a importar se leen de:  %s' % FICHERO_USUARIOS)
    aviso('')
    aviso('  Dejalo abierto. Ctrl+C para parar.')
    aviso('')

    servidor = HTTPServer(('0.0.0.0', PUERTO), Handler)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        aviso('\n  Parado.')
        servidor.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
