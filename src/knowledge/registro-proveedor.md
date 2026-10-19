# Conocimiento del Proceso: Registro como Proveedor (Periferia IT Group)

## 1. Propósito del Proceso
Automatizar el diligenciamiento de formularios de registro como proveedor (Excel, PDF o Portal Web) a partir de solicitudes de clientes en Latinoamérica (CO, EC, PE, PA, HN), cruzando contra el repositorio maestro (`maestro.json`), el diccionario de sinónimos (`glosario-campos.json`) y el índice de soportes (`soportes/index.json`).

## 2. Reglas de Negocio Obligatorias
- **RN1 (Identificador Tributario por País):**
  - Equivalencias: Colombia (`CO`) → `NIT`; Ecuador (`EC`), Perú (`PE`) y Panamá (`PA`) → `RUC`; Honduras (`HN`) → `RTN`.
  - Periferia IT Group S.A.S. solo posee NIT colombiano (`900123456`). Para clientes de países distintos a `CO`, el campo se llena con el NIT colombiano pero se clasifica obligatoriamente como `requiere_confirmacion` con la nota `"identificador extranjero"`.
  - Si la etiqueta de la plantilla es ambigua (ej. `"Identificación tributaria"` o `"Número de identificación fiscal"`), se reporta como `requiere_confirmacion` proponiendo el equivalente según el país del cliente.
- **RN2 (Reserva de Datos Bancarios):**
  - Los datos bajo la ruta `banco.*` solo se diligencian en el formulario si la plantilla los solicita explícitamente.
  - **Nunca** se incluyen datos bancarios en `borrador-correo.md`.
- **RN3 (Vigencia y Bloqueo de Firma):**
  - Un soporte con `vigencia_hasta` anterior a la fecha de ejecución se marca `vencido` y bloquea `listo_para_firma = false`.
  - Un soporte exigido que no exista en `repositorio/soportes/index.json` se marca `ausente` y bloquea `listo_para_firma = false`.
  - Un campo `faltante` en el formulario **no** bloquea `listo_para_firma`, pero debe listarse explícitamente en `checklist.md`.
- **RN4 (Confirmación Humana / Human-in-the-Loop):**
  - El agente jamás firma ni ejecuta envíos sin confirmación explícita del usuario en el turno inmediatamente anterior.
- **RN5 (Trazabilidad):**
  - Toda ejecución de herramienta registra un evento JSONL en `out/<caso>/log.jsonl` y en `out/log.jsonl`.
