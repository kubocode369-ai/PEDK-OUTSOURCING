"""
Genera la plantilla de Excel para importar usuarios (herramientas/plantilla-usuarios.xlsx)
y la incrusta en la app (src/plantilla.js), para que la web la pueda descargar.

    python herramientas/hacer-plantilla.py

Por qué a mano y no con una librería: no hace falta instalar nada, y el fichero queda
mínimo (la impresora sólo manda ~1,8 KB por respuesta, así que se sirve por partes).

Las tres columnas van en FORMATO TEXTO: si no, Excel convierte "0912345678" o el PIN
"0123" en números y se come el cero inicial. La plantilla NO trae filas de ejemplo: una
plantilla con ejemplos acabó una vez dada de alta como si fueran personas de verdad.
"""
import base64
import io
import os
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'''

WORKBOOK = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Usuarios" sheetId="1" r:id="rId1"/><sheet name="Instrucciones" sheetId="2" r:id="rId2"/></sheets></workbook>'''

WORKBOOK_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'''

# Estilo 1: texto (numFmt 49 = "@"). Estilo 2: texto y negrita, para la cabecera.
STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'''


def celda(ref, texto, estilo):
    texto = texto.replace('&', '&amp;').replace('<', '&lt;')
    return '<c r="%s" s="%d" t="inlineStr"><is><t>%s</t></is></c>' % (ref, estilo, texto)


HOJA_USUARIOS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<cols><col min="1" max="1" width="18" style="1" customWidth="1"/><col min="2" max="2" width="10" style="1" customWidth="1"/>'
    '<col min="3" max="3" width="36" style="1" customWidth="1"/></cols>'
    '<sheetData><row r="1">' + celda('A1', 'Usuario', 2) + celda('B1', 'PIN', 2) + celda('C1', 'Nombre completo', 2)
    + '</row></sheetData></worksheet>')

INSTRUCCIONES = [
    'Escriba una persona por fila en la hoja "Usuarios", desde la fila 2. No cambie los títulos.',
    'Usuario: minúsculas, números y . _ - (sin espacios ni tildes). Es el Nombre que se pone en el driver de su PC.',
    'PIN: de 4 a 8 números. Es la Contraseña del driver. Las columnas están en formato texto para que no se pierdan los ceros.',
    'Nombre completo: opcional, para saber quién es cada usuario.',
    'Los usuarios que ya existan en la impresora se saltan: no se cambian. Para cambiar a alguien use su ficha en la web.',
    'Este fichero lleva los PIN en claro: bórrelo o guárdelo como un documento confidencial después de importar.',
]
HOJA_INSTRUCCIONES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<cols><col min="1" max="1" width="120" customWidth="1"/></cols><sheetData>'
    + ''.join('<row r="%d">%s</row>' % (i + 1, celda('A%d' % (i + 1), t, 0)) for i, t in enumerate(INSTRUCCIONES))
    + '</sheetData></worksheet>')


def plantilla():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for nombre, texto in [('[Content_Types].xml', CONTENT_TYPES), ('_rels/.rels', RELS),
                              ('xl/workbook.xml', WORKBOOK), ('xl/_rels/workbook.xml.rels', WORKBOOK_RELS),
                              ('xl/styles.xml', STYLES), ('xl/worksheets/sheet1.xml', HOJA_USUARIOS),
                              ('xl/worksheets/sheet2.xml', HOJA_INSTRUCCIONES)]:
            z.writestr(zipfile.ZipInfo(nombre, (2026, 1, 1, 0, 0, 0)), texto.encode('utf-8'), zipfile.ZIP_DEFLATED)
    return buf.getvalue()


if __name__ == '__main__':
    datos = plantilla()
    with open(os.path.join(AQUI, 'plantilla-usuarios.xlsx'), 'wb') as f:
        f.write(datos)
    b64 = base64.b64encode(datos).decode('ascii')
    with open(os.path.join(AQUI, '..', 'src', 'plantilla.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('/**\n * Plantilla de Excel para importar usuarios, en base64. GENERADO por\n'
                ' * herramientas/hacer-plantilla.py: no editar a mano.\n */\n'
                "export const PLANTILLA_XLSX_B64 = '" + b64 + "';\n")
    print('plantilla: %d bytes (%d en base64)' % (len(datos), len(b64)))
