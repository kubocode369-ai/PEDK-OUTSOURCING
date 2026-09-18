#!/usr/bin/env python3
"""
Servidor de respaldo para la app "Impresión con PIN" (Pantum BM5220ADW).

Se lanza en un PC de la misma red que la impresora y atiende dos cosas:

  POST /respaldo       la impresora manda TODO (usuarios, huellas de PIN, contadores).
                       Se guarda en respaldos/respaldo-AAAAMMDD-HHMMSS.json, y también
                       como respaldos/ultimo.json para tenerlo siempre a mano.

  GET  /usuarios.json  gente NUEVA a dar de alta en bloque. Se sirve el fichero
                       usuarios.json de esta carpeta, que escribes tú con los PIN.

  GET  /restaurar.json el ÚLTIMO respaldo, para devolver la impresora a como estaba.
                       Lleva las huellas, así que cada persona conserva su PIN.

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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PUERTO = 8099                       # tiene que coincidir con config.RESPALDO_PUERTO
AQUI = os.path.dirname(os.path.abspath(__file__))
CARPETA_RESPALDOS = os.path.join(AQUI, 'respaldos')
FICHERO_USUARIOS = os.path.join(AQUI, 'usuarios.json')
LIMITE_BYTES = 4 * 1024 * 1024      # un respaldo real son unos pocos KB


def aviso(texto):
    """Imprime YA: sin flush, Python lo retiene cuando la salida no es una consola."""
    print(texto, flush=True)


def desactivar_seleccion_rapida():
    """
    Windows: al hacer clic dentro de la consola se entra en "modo selección" y el
    proceso queda CONGELADO hasta que se pulsa Enter. No va lento: está parado.

    Eso es lo que hacía que un segundo respaldo no llegara hasta dar Enter: el
    respaldo salía de la impresora, pero este programa estaba detenido por un clic.
    Aquí se apaga QuickEdit para que un clic no pueda volver a parar el servidor.
    """
    if os.name != 'nt':
        return
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        entrada = kernel32.GetStdHandle(-10)          # STD_INPUT_HANDLE
        modo = wintypes.DWORD()
        if not kernel32.GetConsoleMode(entrada, ctypes.byref(modo)):
            return
        QUICK_EDIT = 0x0040
        EXTENDED = 0x0080        # hay que ponerlo para que quitar QUICK_EDIT valga
        kernel32.SetConsoleMode(entrada, (modo.value & ~QUICK_EDIT) | EXTENDED)
    except Exception:
        pass                     # si no se puede, el servidor funciona igual


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
        if ruta in ('/usuarios.json', '/usuarios'):
            self.servir_json(FICHERO_USUARIOS, 'usuarios.json (altas nuevas)')
        elif ruta in ('/restaurar.json', '/restaurar'):
            self.servir_json(os.path.join(CARPETA_RESPALDOS, 'ultimo.json'),
                             'el ultimo respaldo')
        else:
            self.responder(404, '{"error":"ruta desconocida"}')

    def servir_json(self, camino, que):
        if not os.path.exists(camino):
            aviso('  %s  pidieron %s y no existe (%s)' % (ahora(), que, camino))
            self.responder(404, '{"error":"no existe %s"}' % os.path.basename(camino))
            return
        try:
            with open(camino, encoding='utf-8') as f:
                datos = json.load(f)
        except (ValueError, OSError) as e:
            aviso('  %s  %s no se pudo leer: %s' % (ahora(), que, e))
            self.responder(500, '{"error":"no es JSON valido"}')
            return
        if isinstance(datos, list):
            cuantos = len(datos)
        elif isinstance(datos, dict) and isinstance(datos.get('usuarios'), list):
            cuantos = len(datos['usuarios'])
        else:
            cuantos = 0
        if cuantos == 0:
            aviso('  %s  %s pidio %s y NO TRAE NINGUN USUARIO'
                  % (ahora(), self.client_address[0], que))
        else:
            aviso('  %s  %s se lleva %s (%d usuario(s))'
                  % (ahora(), self.client_address[0], que, cuantos))
        self.responder(200, json.dumps(datos, ensure_ascii=False))

    def log_message(self, formato, *args):
        pass        # se imprime lo interesante a mano, sin el ruido por defecto


def plantilla_usuarios():
    """
    La lista viene VACIA a proposito. Antes traia dos usuarios de ejemplo y, al pulsar
    "Traer usuarios del PC", la impresora daba de alta a gente inventada.
    El ejemplo queda solo como documentacion del formato.
    """
    return {
        "_comentario": [
            "Gente NUEVA a dar de alta en la impresora, en bloque.",
            "Rellena 'usuarios' y pulsa en el panel: Ajustes > Respaldo > Traer usuarios.",
            "nombre: minusculas, digitos y . _ -    pin: de 4 a 8 digitos.",
            "NO borra a nadie: crea los que falten y actualiza el PIN de los que ya estan.",
            "",
            "Para RESTAURAR la impresora a como estaba NO uses este fichero:",
            "pulsa 'Restaurar ultimo respaldo', que usa respaldos/ultimo.json y",
            "conserva el PIN que ya tenia cada persona."
        ],
        "_ejemplo": [
            {"nombre": "ana", "pin": "1234"},
            {"nombre": "luis.perez", "pin": "4321"}
        ],
        "usuarios": []
    }


def main():
    desactivar_seleccion_rapida()
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

    servidor = ThreadingHTTPServer(('0.0.0.0', PUERTO), Handler)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        aviso('\n  Parado.')
        servidor.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
