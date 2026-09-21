#!/usr/bin/env python3
"""
Servidor de respaldo para la app "Impresión con PIN" (Pantum BM5220ADW).

Se lanza en un PC de la misma red que la impresora y atiende dos cosas:

  POST /respaldo       la impresora manda TODO (usuarios, huellas de PIN, contadores).
                       Se guarda en respaldos/respaldo-AAAAMMDD-HHMMSS.json, y también
                       como respaldos/ultimo.json para tenerlo siempre a mano. Además se
                       escribe respaldos/contadores.csv, que se abre con Excel y NO
                       lleva nada secreto: es lo que se puede pasar a contabilidad.

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


def puerto_ocupado():
    """
    Comprueba si YA hay un servidor escuchando.

    En Windows, arrancar un segundo servidor sobre el mismo puerto NO da error: el
    socket se ata igual, pero las peticiones se las sigue quedando el primero. Pasa al
    dejarse una ventana vieja abierta y abrir otra tras actualizar el programa: parece
    que funciona, y en realidad sigue corriendo el codigo antiguo.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.6)
    try:
        s.connect(('127.0.0.1', PUERTO))
        return True
    except OSError:
        return False
    finally:
        s.close()


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
        guardar_ultimo(datos, bonito)

        escribir_csv_contadores(datos)

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


def cuantos_usuarios(datos):
    if isinstance(datos, list):
        return len(datos)
    if isinstance(datos, dict) and isinstance(datos.get('usuarios'), list):
        return len(datos['usuarios'])
    return 0


def leer_json(camino):
    try:
        with open(camino, encoding='utf-8') as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def guardar_ultimo(datos, bonito):
    """
    ultimo.json es EL ULTIMO RESPALDO BUENO, no literalmente el ultimo que llego.

    Medido con el usuario el 18-09-2026: al borrar usuarios para probar la
    restauracion, los respaldos siguientes pisaron ultimo.json con el estado ya vacio,
    y cuando fue a restaurar no habia nada. El respaldo se destruia a si mismo justo
    cuando hacia falta.

    Asi que un respaldo SIN usuarios no pisa el ultimo bueno. El fichero con fecha si
    se guarda siempre: ahi esta todo el historial por si hiciera falta.
    """
    camino = os.path.join(CARPETA_RESPALDOS, 'ultimo.json')
    nuevos = cuantos_usuarios(datos)
    previos = cuantos_usuarios(leer_json(camino)) if os.path.exists(camino) else 0

    if nuevos == 0 and previos > 0:
        aviso('  %s  AVISO: ese respaldo viene SIN usuarios. Se guarda con fecha, pero'
              % ahora())
        aviso('            NO se toca ultimo.json, que sigue con %d usuario(s).' % previos)
        return
    if nuevos < previos:
        aviso('  %s  OJO: este respaldo trae %d usuario(s) y el anterior tenia %d.'
              % (ahora(), nuevos, previos))
    with open(camino, 'w', encoding='utf-8') as f:
        f.write(bonito)


def recuperar_ultimo():
    """
    Si ultimo.json se quedo sin usuarios (por la version vieja de este programa), se
    rehace con el respaldo con fecha mas reciente que si tenga gente. Asi se arregla
    solo, sin que nadie tenga que copiar ficheros a mano.
    """
    camino = os.path.join(CARPETA_RESPALDOS, 'ultimo.json')
    if cuantos_usuarios(leer_json(camino)) > 0:
        return
    if not os.path.isdir(CARPETA_RESPALDOS):
        return
    fechados = sorted((n for n in os.listdir(CARPETA_RESPALDOS)
                       if n.startswith('respaldo-') and n.endswith('.json')), reverse=True)
    for nombre in fechados:
        datos = leer_json(os.path.join(CARPETA_RESPALDOS, nombre))
        if cuantos_usuarios(datos) > 0:
            with open(camino, 'w', encoding='utf-8') as f:
                json.dump(datos, f, indent=2, ensure_ascii=False)
            aviso('  Se rehizo ultimo.json con %s (%d usuario(s)): el anterior estaba vacio.'
                  % (nombre, cuantos_usuarios(datos)))
            return


def limpio(texto):
    """Sin ; ni saltos de linea ni comillas: romperian las columnas en Excel."""
    return ' '.join(str(texto or '').replace(';', ' ').replace('"', ' ').split())


def escribir_csv_contadores(datos):
    """
    Los contadores en un CSV que se abre con doble clic en Excel.

    Es la parte del respaldo que se puede mirar y pasar a contabilidad: NO lleva
    huellas ni nada secreto, solo quien imprimio cuanto. Se reescribe en cada respaldo,
    asi que contadores.csv es siempre el dato de ahora mismo.

    Separador ';' y BOM UTF-8 porque es lo que abre bien Excel en espanol: con ',' lo
    mete todo en una sola columna, y sin BOM se comen los acentos.
    """
    contadores = datos.get('contadores') or {}
    if not isinstance(contadores, dict):
        return
    usuarios = {u.get('nombre'): u for u in (datos.get('usuarios') or [])
                if isinstance(u, dict) and u.get('nombre')}
    # TODOS los usuarios, tambien quien no imprimio nada (que no imprima tambien es un
    # dato), mas quien ya no existe pero tiene paginas contadas. Igual que la web.
    filas = []
    for quien in list(usuarios) + [q for q in contadores if q not in usuarios]:
        c = contadores.get(quien) if isinstance(contadores.get(quien), dict) else {}
        u = usuarios.get(quien)
        if quien == '(sin sesion)':
            nombre, estado = 'Sin identificar', ''
        else:
            nombre = quien
            estado = 'borrado' if not u else ('desactivado' if u.get('activo') is False else 'activo')
        completo = limpio((u or {}).get('nombreCompleto'))
        cedula = limpio((u or {}).get('cedula'))
        impresiones = c.get('impresiones') or 0
        paginas = c.get('paginas') or 0
        copias = c.get('copias') or 0
        paginas_copia = c.get('paginasCopia') or 0
        filas.append((limpio(nombre), completo, cedula, estado,
                      impresiones, paginas, copias, paginas_copia, paginas + paginas_copia))
    filas.sort(key=lambda f: (-f[8], f[0]))       # quien mas gasta, primero

    destino = os.path.join(CARPETA_RESPALDOS, 'contadores.csv')
    with open(destino, 'w', encoding='utf-8-sig', newline='') as f:
        f.write('Actualizado;%s\n\n' % datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
        f.write('Usuario;Nombre completo;Cedula;Estado;Impresiones;Paginas impresas;Copias;'
                'Paginas copiadas;TOTAL paginas\n')
        for fila in filas:
            f.write('%s;%s;%s;%s;%d;%d;%d;%d;%d\n' % fila)
        if filas:
            f.write('TOTAL;;;;%d;%d;%d;%d;%d\n' % tuple(sum(f[i] for f in filas) for i in range(4, 9)))
    return destino


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
    if puerto_ocupado():
        aviso('')
        aviso('  YA HAY UN SERVIDOR DE RESPALDO ABIERTO en el puerto %d.' % PUERTO)
        aviso('')
        aviso('  Cierra la otra ventana negra y vuelve a abrir esta.')
        aviso('  (Si dejas las dos, sigue mandando la vieja y los cambios no se aplican.)')
        aviso('')
        return 1
    recuperar_ultimo()
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
    aviso('    Los contadores, para Excel, en:  %s' % os.path.join(CARPETA_RESPALDOS, 'contadores.csv'))
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
