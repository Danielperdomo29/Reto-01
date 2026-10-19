---
name: registro-proveedor
description: Conocimiento normativo y reglas de negocio (RN1-RN5) para el registro de Periferia IT Group como proveedor ante clientes en Latinoamérica.
---

# Reglas de Negocio del Proceso Registro como Proveedor

- **RN1 (Identificador Tributario por País):** CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Periferia solo tiene NIT colombiano (`900123456`); para otros países el campo se llena con el NIT y se marca `requiere_confirmacion` con la nota "identificador extranjero".
- **RN2 (Datos Bancarios):** Solo se llenan si la plantilla los pide explícitamente. Nunca se incluyen en `borrador-correo.md`.
- **RN3 (Vigencia de Soportes):** Un soporte con `vigencia_hasta` anterior a la fecha de ejecución o un soporte ausente bloquea `listo_para_firma = false`. Un campo `faltante` no lo bloquea, pero aparece en `checklist.md`.
- **RN4 (Confirmación Humana):** Ningún envío externo se ejecuta sin confirmación explícita del humano en el turno inmediatamente anterior.
- **RN5 (Auditoría):** Toda herramienta registra su resultado en `out/<caso>/log.jsonl` y `out/log.jsonl`.
