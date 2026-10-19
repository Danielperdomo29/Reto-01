import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

export interface CampoSolicitado {
  etiqueta: string;
  obligatorio?: boolean;
  hoja?: string;
  celda_etiqueta?: string;
  celda_valor?: string;
}

export interface CampoMapeado {
  etiqueta: string;
  estado: "lleno" | "faltante" | "requiere_confirmacion";
  ruta_maestro: string | null;
  valor: string | number | boolean | null;
  confianza: number;
  nota?: string;
  hoja?: string;
  celda_etiqueta?: string;
  celda_valor?: string;
}

const EQUIVALENTE_TRIBUTARIO: Record<string, string> = {
  CO: "NIT",
  EC: "RUC",
  PE: "RUC",
  PA: "RUC",
  HN: "RTN",
};

export const casoIdRegex = /^[a-z0-9-]+$/;

export function sanitizeCaso(caso: string): string {
  const cleaned = String(caso || "").trim();
  if (!/^[a-z0-9-]+$/.test(cleaned)) {
    throw new Error(`Identificador de caso invalido: '${caso}'. Solo se permiten letras minusculas, numeros y guiones.`);
  }
  return cleaned;
}

export function resolveOutDir(directory: string, caso: string): string {
  const safeCaso = sanitizeCaso(caso);
  const outRoot = path.resolve(directory, "out");
  const target = path.resolve(outRoot, safeCaso);
  if (!target.startsWith(outRoot)) {
    throw new Error("Violacion de seguridad: Intento de path traversal detectado.");
  }
  return target;
}

function getReferenceDate(): string {
  if (process.env.REFERENCE_DATE) {
    return process.env.REFERENCE_DATE;
  }
  return new Date().toISOString().split("T")[0];
}

function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function appendAuditLog(
  directory: string,
  caso: string | undefined,
  herramienta: string,
  ok: boolean,
  resumen: string
): void {
  try {
    const entry =
      JSON.stringify({
        ts: new Date().toISOString(),
        herramienta,
        ok,
        resumen,
      }) + "\n";

    const rootOutDir = path.join(directory, "out");
    fs.mkdirSync(rootOutDir, { recursive: true });
    fs.appendFileSync(path.join(rootOutDir, "log.jsonl"), entry, "utf8");

    if (caso && /^[a-zA-Z0-9_-]+$/.test(caso)) {
      const casoOutDir = path.join(rootOutDir, caso);
      fs.mkdirSync(casoOutDir, { recursive: true });
      fs.appendFileSync(path.join(casoOutDir, "log.jsonl"), entry, "utf8");
    }
  } catch {
    // Nunca lanzar excepcion desde el logger (HU-5)
  }
}

function resolveFixturesDir(directory: string): string {
  const direct = path.join(directory, "fixtures", "reto-01");
  if (fs.existsSync(direct)) return direct;
  const fallback = path.join(directory, "fixtures");
  return fallback;
}

function findCaseFile(casoDir: string, caso: string, prefix: string): string | null {
  const candidates = [
    path.join(casoDir, `${prefix}.json`),
    path.join(casoDir, `${prefix}-${caso}.json`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ============================================================================
// 1. proveedor_leer_solicitud
// ============================================================================
const leerSolicitudSchema = z.object({
  caso: z.string().regex(casoIdRegex, "El caso solo puede contener letras minusculas, numeros y guiones").describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
});

export const leer_solicitud = {
  description:
    "Lee solicitud.json, la plantilla adjunta (xlsx, pdf o portal) y los soportes exigidos de un caso.",
  args: leerSolicitudSchema.shape,
  async execute(
    rawArgs: z.infer<typeof leerSolicitudSchema>,
    ctx: ToolContext
  ): Promise<string> {
    const toolName = "proveedor_leer_solicitud";
    try {
      const parsed = leerSolicitudSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = `Argumentos invalidos: ${parsed.error.message}`;
        appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const { caso } = parsed.data;
      const baseFixtures = resolveFixturesDir(ctx.directory);
      const casoDir = path.join(baseFixtures, "casos", caso);

      if (!fs.existsSync(casoDir)) {
        const msg = `El caso '${caso}' no existe en fixtures/reto-01/casos/`;
        appendAuditLog(ctx.directory, caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const solicitudPath = findCaseFile(casoDir, caso, "solicitud");
      if (!solicitudPath) {
        const msg = `No se encontro solicitud.json en el caso '${caso}'`;
        appendAuditLog(ctx.directory, caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const solicitud = JSON.parse(fs.readFileSync(solicitudPath, "utf8"));
      const rawFormato = String(solicitud.formato || "").toLowerCase();
      let formato: "xlsx" | "pdf" | "portal" = "portal";
      if (rawFormato.includes("xls") || rawFormato === "excel") {
        formato = "xlsx";
      } else if (rawFormato.includes("pdf")) {
        formato = "pdf";
      } else if (rawFormato.includes("portal") || rawFormato.includes("web")) {
        formato = "portal";
      }

      const campos: CampoSolicitado[] = [];
      const celdasPath = findCaseFile(casoDir, caso, "plantilla-celdas");
      const camposPath = findCaseFile(casoDir, caso, "plantilla-campos");
      let advertenciaPlantilla: string | null = null;

      try {
        if (celdasPath && fs.existsSync(celdasPath)) {
          const rawCeldas = JSON.parse(fs.readFileSync(celdasPath, "utf8"));
          const listaCeldas = Array.isArray(rawCeldas)
            ? rawCeldas
            : rawCeldas.celdas || rawCeldas.campos || [];
          for (const item of listaCeldas) {
            campos.push({
              etiqueta: String(item.etiqueta || item.campo || item.label || "").trim(),
              hoja: item.hoja || "Registro",
              celda_etiqueta: item.celda_etiqueta,
              celda_valor: item.celda_valor,
              obligatorio: item.obligatorio ?? true,
            });
          }
        } else if (camposPath && fs.existsSync(camposPath)) {
          const rawCampos = JSON.parse(fs.readFileSync(camposPath, "utf8"));
          const listaCampos = Array.isArray(rawCampos)
            ? rawCampos
            : rawCampos.campos || [];
          for (const item of listaCampos) {
            if (typeof item === "string") {
              campos.push({ etiqueta: item.trim(), obligatorio: true });
            } else {
              campos.push({
                etiqueta: String(item.etiqueta || item.campo || item.label || "").trim(),
                obligatorio: item.obligatorio ?? true,
              });
            }
          }
        }
      } catch (errTpl: unknown) {
        advertenciaPlantilla = `Plantilla ilegible o corrupta: ${errTpl instanceof Error ? errTpl.message : String(errTpl)}. Se procede con el checklist de soportes.`;
      }

      const soportesPath = findCaseFile(casoDir, caso, "soportes-exigidos");
      let soportes: string[] = [];
      if (soportesPath && fs.existsSync(soportesPath)) {
        const rawSoportes = JSON.parse(fs.readFileSync(soportesPath, "utf8"));
        const arr = Array.isArray(rawSoportes)
          ? rawSoportes
          : rawSoportes.soportes || rawSoportes.exigidos || [];
        soportes = arr.map((s: unknown) =>
          typeof s === "string"
            ? s
            : String((s as Record<string, unknown>).tipo || (s as Record<string, unknown>).nombre || "")
        );
      }

      const data = {
        id: solicitud.id || caso,
        pais: String(solicitud.pais || "CO").toUpperCase(),
        cliente: String(solicitud.cliente || caso),
        asunto: solicitud.asunto || "",
        fecha: solicitud.fecha || "",
        de: solicitud.de || "",
        formato,
        campos,
        soportes,
        advertencia: advertenciaPlantilla,
      };

      const resumen = `Solicitud leida (${data.cliente}, pais ${data.pais}, formato ${data.formato}, ${campos.length} campos, ${soportes.length} soportes).`;
      appendAuditLog(ctx.directory, caso, toolName, true, resumen);
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      const msg = `Error leyendo solicitud: ${err instanceof Error ? err.message : String(err)}`;
      appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ============================================================================
// 2. proveedor_mapear_campos
// ============================================================================
const mapearCamposSchema = z.object({
  caso: z.string().regex(casoIdRegex, "El caso solo puede contener letras minusculas, numeros y guiones").describe("Nombre de la carpeta del caso"),
  campos: z.array(z.union([z.string(), z.record(z.unknown())])).optional().describe("Lista opcional de etiquetas de campos"),
});

export const mapear_campos = {
  description:
    "Cruza cada campo solicitado con el glosario de sinónimos y el repositorio maestro, clasificando en llenos, faltantes y requiere_confirmacion.",
  args: mapearCamposSchema.shape,
  async execute(
    rawArgs: z.infer<typeof mapearCamposSchema>,
    ctx: ToolContext
  ): Promise<string> {
    const toolName = "proveedor_mapear_campos";
    try {
      const parsed = mapearCamposSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = `Argumentos invalidos: ${parsed.error.message}`;
        appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const { caso } = parsed.data;
      const baseFixtures = resolveFixturesDir(ctx.directory);
      const glosarioPath = path.join(baseFixtures, "glosario-campos.json");
      const maestroPath = path.join(baseFixtures, "repositorio", "maestro.json");

      if (!fs.existsSync(glosarioPath) || !fs.existsSync(maestroPath)) {
        const msg = "No se encontro glosario-campos.json o repositorio/maestro.json";
        appendAuditLog(ctx.directory, caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const glosarioRaw: Record<string, string> = JSON.parse(
        fs.readFileSync(glosarioPath, "utf8")
      );
      const maestro: Record<string, unknown> = JSON.parse(
        fs.readFileSync(maestroPath, "utf8")
      );

      const lecturaRaw = JSON.parse(
        await leer_solicitud.execute({ caso }, ctx)
      );
      if (!lecturaRaw.ok) {
        appendAuditLog(ctx.directory, caso, toolName, false, lecturaRaw.error);
        return JSON.stringify({ ok: false, error: lecturaRaw.error });
      }

      const paisCliente: string = lecturaRaw.data.pais;
      const plantillaCampos: CampoSolicitado[] = lecturaRaw.data.campos || [];

      if (plantillaCampos.length === 0) {
        const emptyData = {
          llenos: [],
          requiere_confirmacion: [],
          faltantes: [],
          advertencia: lecturaRaw.data?.advertencia || "Sin campos mapeables debido a plantilla ilegible o vacia.",
        };
        const casoOutDir = resolveOutDir(ctx.directory, caso);
        fs.mkdirSync(casoOutDir, { recursive: true });
        fs.writeFileSync(path.join(casoOutDir, "mapeo.json"), JSON.stringify(emptyData, null, 2), "utf8");
        appendAuditLog(ctx.directory, caso, toolName, true, "Mapeo completado sin campos por plantilla vacia o corrupta.");
        return JSON.stringify({ ok: true, data: emptyData });
      }

      const camposAProcesar: CampoSolicitado[] =
        parsed.data.campos && parsed.data.campos.length > 0
          ? parsed.data.campos.map((c, idx) => {
              const etiqueta =
                typeof c === "string"
                  ? c
                  : String(c.etiqueta || c.campo || c.label || "");
              const matchPlantilla =
                plantillaCampos.find(
                  (p) => normalizeText(p.etiqueta) === normalizeText(etiqueta)
                ) || plantillaCampos[idx];
              return {
                etiqueta,
                obligatorio:
                  typeof c === "object" && "obligatorio" in c
                    ? Boolean(c.obligatorio)
                    : matchPlantilla?.obligatorio ?? true,
                hoja:
                  typeof c === "object" && c.hoja
                    ? String(c.hoja)
                    : matchPlantilla?.hoja,
                celda_etiqueta:
                  typeof c === "object" && c.celda_etiqueta
                    ? String(c.celda_etiqueta)
                    : matchPlantilla?.celda_etiqueta,
                celda_valor:
                  typeof c === "object" && c.celda_valor
                    ? String(c.celda_valor)
                    : matchPlantilla?.celda_valor,
              };
            })
          : plantillaCampos;

      const glosarioNorm = new Map<string, { originalKey: string; targetPath: string }>();
      for (const [k, v] of Object.entries(glosarioRaw)) {
        glosarioNorm.set(normalizeText(k), { originalKey: k, targetPath: v });
      }

      const llenos: CampoMapeado[] = [];
      const faltantes: CampoMapeado[] = [];
      const requiere_confirmacion: CampoMapeado[] = [];

      const ETIQUETAS_TRIBUTARIAS_AMBIGUAS = new Set([
        normalizeText("Identificación tributaria"),
        normalizeText("Número de identificación fiscal"),
        normalizeText("Identificacion fiscal"),
        normalizeText("Registro fiscal"),
      ]);

      for (const item of camposAProcesar) {
        const normLabel = normalizeText(item.etiqueta);
        let rutaMaestro: string | null = null;
        let confianza = 1.0;

        const hitGlosario = glosarioNorm.get(normLabel);
        if (hitGlosario) {
          rutaMaestro = hitGlosario.targetPath;
          confianza = 1.0;
        } else if (normLabel in maestro) {
          rutaMaestro = normLabel;
          confianza = 0.9;
        } else {
          for (const [gKeyNorm, gVal] of glosarioNorm.entries()) {
            if (
              (normLabel.length > 4 && gKeyNorm.includes(normLabel)) ||
              (gKeyNorm.length > 4 && normLabel.includes(gKeyNorm))
            ) {
              rutaMaestro = gVal.targetPath;
              confianza = 0.75;
              break;
            }
          }
        }

        if (!rutaMaestro) {
          faltantes.push({
            etiqueta: item.etiqueta,
            estado: "faltante",
            ruta_maestro: null,
            valor: null,
            confianza: 0,
            nota: "No existe correspondencia en glosario ni en repositorio maestro",
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
          continue;
        }

        const rawVal = getNestedValue(maestro, rutaMaestro);
        if (rawVal === undefined || rawVal === null || rawVal === "") {
          faltantes.push({
            etiqueta: item.etiqueta,
            estado: "faltante",
            ruta_maestro: rutaMaestro,
            valor: null,
            confianza: 0,
            nota: `La ruta '${rutaMaestro}' no tiene valor en maestro.json`,
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
          continue;
        }

        const valorFormateado = Array.isArray(rawVal)
          ? rawVal.join(", ")
          : typeof rawVal === "object"
          ? JSON.stringify(rawVal)
          : (rawVal as string | number | boolean);

        const eqTributario = EQUIVALENTE_TRIBUTARIO[paisCliente] || "NIT";
        const esCampoTributario =
          rutaMaestro === "nit" || rutaMaestro === "digito_verificacion";
        const esEtiquetaAmbigua = ETIQUETAS_TRIBUTARIAS_AMBIGUAS.has(normLabel);

        if (rutaMaestro === "nit" && paisCliente !== "CO") {
          requiere_confirmacion.push({
            etiqueta: item.etiqueta,
            estado: "requiere_confirmacion",
            ruta_maestro: rutaMaestro,
            valor: valorFormateado,
            confianza: 0.7,
            nota: `identificador extranjero: Periferia solo posee NIT colombiano (${valorFormateado}); equivale a ${eqTributario} en ${paisCliente}`,
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
        } else if (esCampoTributario && esEtiquetaAmbigua) {
          requiere_confirmacion.push({
            etiqueta: item.etiqueta,
            estado: "requiere_confirmacion",
            ruta_maestro: rutaMaestro,
            valor: valorFormateado,
            confianza: 0.75,
            nota: `Campo tributario ambiguo; se propone equivalente del país (${eqTributario} en ${paisCliente})`,
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
        } else if (confianza < 0.8) {
          requiere_confirmacion.push({
            etiqueta: item.etiqueta,
            estado: "requiere_confirmacion",
            ruta_maestro: rutaMaestro,
            valor: valorFormateado,
            confianza,
            nota: `Mapeo por similitud parcial con confianza ${confianza} (< 0.8)`,
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
        } else {
          llenos.push({
            etiqueta: item.etiqueta,
            estado: "lleno",
            ruta_maestro: rutaMaestro,
            valor: valorFormateado,
            confianza,
            hoja: item.hoja,
            celda_etiqueta: item.celda_etiqueta,
            celda_valor: item.celda_valor,
          });
        }
      }

      const data = {
        caso,
        pais: paisCliente,
        llenos,
        faltantes,
        requiere_confirmacion,
      };

      const casoOutDir = resolveOutDir(ctx.directory, caso);
      fs.mkdirSync(casoOutDir, { recursive: true });
      fs.writeFileSync(
        path.join(casoOutDir, "mapeo.json"),
        JSON.stringify(data, null, 2),
        "utf8"
      );

      const resumen = `Mapeo completado: ${llenos.length} llenos, ${requiere_confirmacion.length} requieren confirmación, ${faltantes.length} faltantes.`;
      appendAuditLog(ctx.directory, caso, toolName, true, resumen);
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      const msg = `Error mapeando campos: ${err instanceof Error ? err.message : String(err)}`;
      appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ============================================================================
// 3. proveedor_generar_formulario
// ============================================================================
const generarFormularioSchema = z.object({
  caso: z.string().regex(casoIdRegex, "El caso solo puede contener letras minusculas, numeros y guiones").describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  mapeo: z.record(z.unknown()).optional().describe("Opcional: el mapeo se lee siempre de forma segura desde out/<caso>/mapeo.json para prevenir inyecciones"),
});

export const generar_formulario = {
  description:
    "Genera el formulario diligenciado en el formato requerido por el cliente (out/<caso>/formulario.xlsx, out/<caso>/formulario.pdf o out/<caso>/valores-portal.md).",
  args: generarFormularioSchema.shape,
  async execute(
    rawArgs: z.infer<typeof generarFormularioSchema>,
    ctx: ToolContext
  ): Promise<string> {
    const toolName = "proveedor_generar_formulario";
    try {
      const parsed = generarFormularioSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = `Argumentos invalidos: ${parsed.error.message}`;
        appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const { caso } = parsed.data;
      const lecturaRaw = JSON.parse(await leer_solicitud.execute({ caso }, ctx));
      if (!lecturaRaw.ok) {
        appendAuditLog(ctx.directory, caso, toolName, false, lecturaRaw.error);
        return JSON.stringify({ ok: false, error: lecturaRaw.error });
      }

      const formato: "xlsx" | "pdf" | "portal" = lecturaRaw.data.formato;
      const cliente: string = lecturaRaw.data.cliente;
      const pais: string = lecturaRaw.data.pais;

      const casoOutDir = resolveOutDir(ctx.directory, caso);
      const cachedMapeoPath = path.join(casoOutDir, "mapeo.json");
      let mapeoData: {
        llenos: CampoMapeado[];
        requiere_confirmacion: CampoMapeado[];
        faltantes: CampoMapeado[];
      };

      // Seguridad CA2: Cargar siempre el mapeo verificado desde out/<caso>/mapeo.json para prevenir inyecciones del LLM
      if (fs.existsSync(cachedMapeoPath)) {
        mapeoData = JSON.parse(fs.readFileSync(cachedMapeoPath, "utf8"));
      } else {
        const calc = JSON.parse(await mapear_campos.execute({ caso }, ctx));
        if (!calc.ok) {
          return JSON.stringify({ ok: false, error: calc.error });
        }
        mapeoData = calc.data;
      }

      const llenos: CampoMapeado[] = mapeoData?.llenos || [];
      const requiereConfirmacion: CampoMapeado[] =
        mapeoData?.requiere_confirmacion || [];
      const faltantes: CampoMapeado[] = mapeoData?.faltantes || [];

      const todosMapeados = [...llenos, ...requiereConfirmacion, ...faltantes];
      const porEtiqueta = new Map<string, CampoMapeado>();
      for (const m of todosMapeados) {
        porEtiqueta.set(normalizeText(m.etiqueta), m);
      }

      fs.mkdirSync(casoOutDir, { recursive: true });

      if (formato === "portal") {
        const relPath = `out/${caso}/valores-portal.md`;
        const absPath = path.join(ctx.directory, relPath);

        const lines: string[] = [
          `# Valores para Carga Manual en Portal Web — ${cliente} (${pais})`,
          ``,
          `> **Estado:** Formato \`portal\` no soportado para llenado automático directo (HU-3 / RN4).`,
          `> Los siguientes valores han sido validados contra el repositorio maestro para copiar y pegar manualmente en el portal del cliente:`,
          ``,
          `| Etiqueta en Portal | Valor a Ingresar | Estado | Fuente Maestro / Nota |`,
          `|---|---|---|---|`,
        ];

        for (const campo of lecturaRaw.data.campos as CampoSolicitado[]) {
          const m = porEtiqueta.get(normalizeText(campo.etiqueta));
          const val = m && m.valor !== null ? String(m.valor) : "_(FALTANTE - No inventar)_";
          const est = m ? m.estado : "faltante";
          const fuente = m?.ruta_maestro
            ? `\`${m.ruta_maestro}\`${m.nota ? ` — ${m.nota}` : ""}`
            : m?.nota || "Sin fuente en maestro";
          lines.push(`| ${campo.etiqueta} | **${val}** | \`${est}\` | ${fuente} |`);
        }

        fs.writeFileSync(absPath, lines.join("\n") + "\n", "utf8");
        const resumen = `Formato portal web no soportado automáticamente; se generó guía copiable en ${relPath}.`;
        appendAuditLog(ctx.directory, caso, toolName, true, resumen);

        return JSON.stringify({
          ok: true,
          data: {
            ruta: relPath,
            formato: "portal",
            estado_formato: "formato no soportado",
            mensaje:
              "El formato portal web no se llena automáticamente. Se generó out/" +
              caso +
              "/valores-portal.md con los valores listos para copiar.",
          },
        });
      }

      if (formato === "xlsx") {
        const relPath = `out/${caso}/formulario.xlsx`;
        const absPath = path.join(ctx.directory, relPath);
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Agente Registro Proveedor - Periferia IT Group";
        workbook.created = new Date();

        const camposPlantilla: CampoSolicitado[] = lecturaRaw.data.campos;
        for (const celdaInfo of camposPlantilla) {
          const sheetName = celdaInfo.hoja || "Formulario";
          let sheet = workbook.getWorksheet(sheetName);
          if (!sheet) {
            sheet = workbook.addWorksheet(sheetName);
          }

          const m = porEtiqueta.get(normalizeText(celdaInfo.etiqueta));
          if (celdaInfo.celda_etiqueta) {
            const labelCell = sheet.getCell(celdaInfo.celda_etiqueta);
            labelCell.value = celdaInfo.etiqueta;
            labelCell.font = { bold: true };
          }
          if (celdaInfo.celda_valor) {
            const valCell = sheet.getCell(celdaInfo.celda_valor);
            valCell.value =
              m && m.valor !== null && m.valor !== undefined ? String(m.valor) : "";
          }
        }

        await workbook.xlsx.writeFile(absPath);
        const resumen = `Formulario Excel generado exitosamente en ${relPath} (${camposPlantilla.length} celdas procesadas).`;
        appendAuditLog(ctx.directory, caso, toolName, true, resumen);
        return JSON.stringify({
          ok: true,
          data: { ruta: relPath, formato: "xlsx" },
        });
      }

      const relPath = `out/${caso}/formulario.pdf`;
      const absPath = path.join(ctx.directory, relPath);
      const pdfDoc = await PDFDocument.create();
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      let page = pdfDoc.addPage([595.28, 841.89]); // A4
      let { height } = page.getSize();
      let y = height - 50;

      const sanitizePdfText = (str: string) =>
        str.replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

      page.drawText(
        sanitizePdfText(`FORMULARIO DE REGISTRO DE PROVEEDOR - ${cliente.toUpperCase()}`),
        { x: 45, y, size: 13, font: fontBold, color: rgb(0.08, 0.2, 0.45) }
      );
      y -= 18;
      page.drawText(
        sanitizePdfText(`Pais Cliente: ${pais} | Proveedor: Periferia IT Group S.A.S.`),
        { x: 45, y, size: 10, font: fontRegular, color: rgb(0.3, 0.3, 0.3) }
      );
      y -= 25;

      const camposPlantilla: CampoSolicitado[] = lecturaRaw.data.campos;
      for (let i = 0; i < camposPlantilla.length; i++) {
        if (y < 70) {
          page = pdfDoc.addPage([595.28, 841.89]);
          height = page.getSize().height;
          y = height - 50;
        }
        const campo = camposPlantilla[i];
        const m = porEtiqueta.get(normalizeText(campo.etiqueta));
        const valorTexto =
          m && m.valor !== null && m.valor !== undefined
            ? String(m.valor)
            : "[FALTANTE EN MAESTRO]";
        const estadoTexto = m ? m.estado.toUpperCase() : "FALTANTE";

        page.drawText(
          sanitizePdfText(`${i + 1}. ${campo.etiqueta}${campo.obligatorio ? " *" : ""}:`),
          { x: 45, y, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.1) }
        );
        y -= 14;
        page.drawText(
          sanitizePdfText(`   Valor: ${valorTexto}  (${estadoTexto})`),
          { x: 55, y, size: 10, font: fontRegular, color: rgb(0.15, 0.15, 0.15) }
        );
        if (m?.nota) {
          y -= 12;
          page.drawText(sanitizePdfText(`   Nota: ${m.nota}`), {
            x: 55,
            y,
            size: 8.5,
            font: fontRegular,
            color: rgb(0.55, 0.25, 0.05),
          });
        }
        y -= 18;
      }

      const pdfBytes = await pdfDoc.save();
      fs.writeFileSync(absPath, pdfBytes);

      const resumen = `Formulario PDF generado exitosamente en ${relPath} (${camposPlantilla.length} campos en orden).`;
      appendAuditLog(ctx.directory, caso, toolName, true, resumen);
      return JSON.stringify({
        ok: true,
        data: { ruta: relPath, formato: "pdf" },
      });
    } catch (err) {
      const msg = `Error generando formulario: ${err instanceof Error ? err.message : String(err)}`;
      appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ============================================================================
// 4. proveedor_armar_paquete
// ============================================================================
const armarPaqueteSchema = z.object({
  caso: z.string().regex(casoIdRegex, "El caso solo puede contener letras minusculas, numeros y guiones").describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
});

export const armar_paquete = {
  description:
    "Arma la carpeta out/<caso>/paquete/ con el formulario generado, copias de los soportes disponibles, checklist.md (validando vigencias según RN3) y borrador-correo.md (sin datos bancarios según RN2).",
  args: armarPaqueteSchema.shape,
  async execute(
    rawArgs: z.infer<typeof armarPaqueteSchema>,
    ctx: ToolContext
  ): Promise<string> {
    const toolName = "proveedor_armar_paquete";
    try {
      const parsed = armarPaqueteSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = `Argumentos invalidos: ${parsed.error.message}`;
        appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const { caso } = parsed.data;
      const baseFixtures = resolveFixturesDir(ctx.directory);
      const lecturaRaw = JSON.parse(await leer_solicitud.execute({ caso }, ctx));
      if (!lecturaRaw.ok) {
        appendAuditLog(ctx.directory, caso, toolName, false, lecturaRaw.error);
        return JSON.stringify({ ok: false, error: lecturaRaw.error });
      }

      const { cliente, pais, formato, soportes: soportesExigidos } = lecturaRaw.data;

      const casoOutDir = resolveOutDir(ctx.directory, caso);
      const cachedMapeoPath = path.join(casoOutDir, "mapeo.json");
      let mapeoData: {
        llenos: CampoMapeado[];
        faltantes: CampoMapeado[];
        requiere_confirmacion: CampoMapeado[];
      };

      if (fs.existsSync(cachedMapeoPath)) {
        mapeoData = JSON.parse(fs.readFileSync(cachedMapeoPath, "utf8"));
      } else {
        const resMapeo = JSON.parse(await mapear_campos.execute({ caso }, ctx));
        if (!resMapeo.ok) return JSON.stringify({ ok: false, error: resMapeo.error });
        mapeoData = resMapeo.data;
      }

      const formFileName =
        formato === "xlsx"
          ? "formulario.xlsx"
          : formato === "pdf"
          ? "formulario.pdf"
          : "valores-portal.md";
      const formSourcePath = path.join(casoOutDir, formFileName);
      if (!fs.existsSync(formSourcePath)) {
        await generar_formulario.execute({ caso, mapeo: mapeoData }, ctx);
      }

      const paqueteDir = path.join(casoOutDir, "paquete");
      fs.mkdirSync(paqueteDir, { recursive: true });

      if (fs.existsSync(formSourcePath)) {
        fs.copyFileSync(formSourcePath, path.join(paqueteDir, formFileName));
      }

      const indexSoportesPath = path.join(
        baseFixtures,
        "repositorio",
        "soportes",
        "index.json"
      );
      const catalogoSoportes: Array<{
        tipo: string;
        archivo: string;
        vigencia_hasta: string | null;
        pais_emisor: string;
        descripcion: string;
      }> = fs.existsSync(indexSoportesPath)
        ? JSON.parse(fs.readFileSync(indexSoportesPath, "utf8"))
        : [];

      const fechaRef = getReferenceDate();
      const estadoSoportes: Array<{
        tipo: string;
        estado: "presente" | "vencido" | "ausente";
        archivo: string | null;
        vigencia_hasta: string | null;
        detalle: string;
      }> = [];

      let bloqueadoPorSoportes = false;

      for (const tipoExigido of soportesExigidos as string[]) {
        const encontrado = catalogoSoportes.find(
          (s) => normalizeText(s.tipo) === normalizeText(tipoExigido)
        );

        if (!encontrado) {
          bloqueadoPorSoportes = true;
          estadoSoportes.push({
            tipo: tipoExigido,
            estado: "ausente",
            archivo: null,
            vigencia_hasta: null,
            detalle: "No existe en repositorio/soportes/index.json (bloquea firma - RN3)",
          });
          continue;
        }

        const origenSoporte = path.join(
          baseFixtures,
          "repositorio",
          "soportes",
          encontrado.archivo
        );
        if (fs.existsSync(origenSoporte)) {
          fs.copyFileSync(origenSoporte, path.join(paqueteDir, encontrado.archivo));
        }

        const estaVencido =
          encontrado.vigencia_hasta !== null &&
          encontrado.vigencia_hasta < fechaRef;

        if (estaVencido) {
          bloqueadoPorSoportes = true;
          estadoSoportes.push({
            tipo: tipoExigido,
            estado: "vencido",
            archivo: encontrado.archivo,
            vigencia_hasta: encontrado.vigencia_hasta,
            detalle: `Vencido el ${encontrado.vigencia_hasta} (fecha evaluación: ${fechaRef}) — Bloquea firma (RN3)`,
          });
        } else {
          estadoSoportes.push({
            tipo: tipoExigido,
            estado: "presente",
            archivo: encontrado.archivo,
            vigencia_hasta: encontrado.vigencia_hasta,
            detalle: encontrado.vigencia_hasta
              ? `Vigente hasta ${encontrado.vigencia_hasta}`
              : "Vigencia indefinida / No aplica",
          });
        }
      }

      const listo_para_firma = !bloqueadoPorSoportes;

      const checklistLines: string[] = [
        `# Checklist de Paquete para Firma — ${cliente} (${pais})`,
        ``,
        `- **Caso:** \`${caso}\``,
        `- **Fecha de verificación:** \`${fechaRef}\``,
        `- **Formato de salida:** \`${formato}\` (\`${formFileName}\`)`,
        `- **Estado General (\`listo_para_firma\`):** **${listo_para_firma ? "SÍ (LISTO PARA FIRMA)" : "NO (BLOQUEADO POR SOPORTES)"}**`,
        ``,
        `## 1. Estado de Soportes Exigidos (Regla RN3)`,
        `| Soporte Exigido | Estado | Archivo | Vigencia Hasta | Observación |`,
        `|---|---|---|---|---|`,
        ...estadoSoportes.map(
          (s) =>
            `| \`${s.tipo}\` | **${s.estado.toUpperCase()}** | ${s.archivo || "N/A"} | ${s.vigencia_hasta || "No aplica"} | ${s.detalle} |`
        ),
        ``,
        `## 2. Campos que Requieren Confirmación (${mapeoData.requiere_confirmacion.length})`,
        ...(mapeoData.requiere_confirmacion.length === 0
          ? [`_Ningún campo requiere confirmación._`]
          : mapeoData.requiere_confirmacion.map(
              (c) =>
                `- **${c.etiqueta}**: \`${c.valor}\` (Fuente: \`${c.ruta_maestro}\`) — _${c.nota}_`
            )),
        ``,
        `## 3. Campos Faltantes en el Maestro (${mapeoData.faltantes.length})`,
        `> Nota RN3: Los campos faltantes no bloquean \`listo_para_firma\`, pero deben ser completados o declarados como no aplicables por el analista.`,
        ...(mapeoData.faltantes.length === 0
          ? [`_Todos los campos solicitados se encontraron en el repositorio maestro._`]
          : mapeoData.faltantes.map((c) => `- **${c.etiqueta}**: _${c.nota}_`)),
        ``,
        `## 4. Campos Llenos Automáticamente (${mapeoData.llenos.length})`,
        ...mapeoData.llenos.map(
          (c) => `- **${c.etiqueta}**: \`${c.valor}\` (Fuente: \`${c.ruta_maestro}\`)`
        ),
      ];

      fs.writeFileSync(
        path.join(paqueteDir, "checklist.md"),
        checklistLines.join("\n") + "\n",
        "utf8"
      );

      const camposNoBancarios = [...mapeoData.llenos, ...mapeoData.requiere_confirmacion].filter(
        (c) => !c.ruta_maestro?.startsWith("banco.")
      );

      const borradorLines: string[] = [
        `Para: ${lecturaRaw.data.de || `compras@${caso}.com`}`,
        `Asunto: RE: ${lecturaRaw.data.asunto || `Registro como proveedor - ${cliente}`}`,
        ``,
        `Estimado equipo de ${cliente},`,
        ``,
        `Cordial saludo. Adjunto a esta comunicación remitimos el paquete de inscripción y registro como proveedor de **Periferia IT Group S.A.S.** junto con los documentos de soporte solicitados.`,
        ``,
        `### Resumen de Datos Corporativos (Sin información bancaria por política de seguridad RN2)`,
        ...camposNoBancarios.map((c) => `- **${c.etiqueta}:** ${c.valor}`),
        ``,
        ...(mapeoData.faltantes.length > 0
          ? [
              `### Campos pendientes de confirmación o no aplicables:`,
              ...mapeoData.faltantes.map((f) => `- ${f.etiqueta}`),
              ``,
            ]
          : []),
        `### Documentos de Soporte Adjuntos:`,
        ...estadoSoportes
          .filter((s) => s.estado === "presente")
          .map((s) => `- ${s.tipo} (${s.archivo})`),
        ``,
        `Quedamos atentos a cualquier inquietud adicional.`,
        ``,
        `Atentamente,`,
        `**Camila Ortiz Vélez**`,
        `Analista Administrativa — Periferia IT Group S.A.S.`,
        `facturacion@periferia-ficticia.com | +57 604 555 0102`,
      ];

      fs.writeFileSync(
        path.join(paqueteDir, "borrador-correo.md"),
        borradorLines.join("\n") + "\n",
        "utf8"
      );

      const relPaquete = `out/${caso}/paquete`;
      const checklistResumen = {
        soportes_presentes: estadoSoportes
          .filter((s) => s.estado === "presente")
          .map((s) => s.tipo),
        soportes_vencidos: estadoSoportes
          .filter((s) => s.estado === "vencido")
          .map((s) => ({ tipo: s.tipo, vigencia_hasta: s.vigencia_hasta })),
        soportes_ausentes: estadoSoportes
          .filter((s) => s.estado === "ausente")
          .map((s) => s.tipo),
        campos_llenos: mapeoData.llenos.length,
        campos_requiere_confirmacion: mapeoData.requiere_confirmacion.length,
        campos_faltantes: mapeoData.faltantes.map((f) => f.etiqueta),
      };

      const resumen = `Paquete armado en ${relPaquete} (listo_para_firma=${listo_para_firma}, presentes=${checklistResumen.soportes_presentes.length}, vencidos=${checklistResumen.soportes_vencidos.length}, ausentes=${checklistResumen.soportes_ausentes.length}).`;
      appendAuditLog(ctx.directory, caso, toolName, true, resumen);

      return JSON.stringify({
        ok: true,
        data: {
          ruta: relPaquete,
          listo_para_firma,
          checklist: checklistResumen,
          archivos_generados: [
            `${relPaquete}/${formFileName}`,
            `${relPaquete}/checklist.md`,
            `${relPaquete}/borrador-correo.md`,
          ],
        },
      });
    } catch (err) {
      const msg = `Error armando paquete: ${err instanceof Error ? err.message : String(err)}`;
      appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

// ============================================================================
// 5. proveedor_simular_envio
// ============================================================================
const simularEnvioSchema = z.object({
  caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  confirmado: z
    .boolean()
    .describe("Debe ser true únicamente si el humano confirmó explícitamente el envío en el turno anterior"),
});

export const simular_envio = {
  description:
    "Simula el envío final del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md únicamente cuando confirmado === true (RN4 / HU-4).",
  args: simularEnvioSchema.shape,
  async execute(
    rawArgs: z.infer<typeof simularEnvioSchema>,
    ctx: ToolContext
  ): Promise<string> {
    const toolName = "proveedor_simular_envio";
    try {
      const parsed = simularEnvioSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const msg = `Argumentos invalidos: ${parsed.error.message}`;
        appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const { caso, confirmado } = parsed.data;
      const safeCaso = sanitizeCaso(caso);
      if (!confirmado) {
        const msg = "requiere confirmación explícita";
        appendAuditLog(ctx.directory, safeCaso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const baseFixtures = resolveFixturesDir(ctx.directory);
      const casoDir = path.join(baseFixtures, "casos", safeCaso);
      if (!fs.existsSync(casoDir)) {
        const msg = `El caso '${safeCaso}' no existe en casos/`;
        appendAuditLog(ctx.directory, safeCaso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      const casoOutDir = resolveOutDir(ctx.directory, safeCaso);
      const resumenPaquetePath = path.join(casoOutDir, "paquete", "checklist.md");
      if (!fs.existsSync(resumenPaquetePath)) {
        const msg = `No existe un paquete armado para el caso '${safeCaso}'. Debe ejecutarse proveedor_armar_paquete primero.`;
        appendAuditLog(ctx.directory, safeCaso, toolName, false, msg);
        return JSON.stringify({ ok: false, error: msg });
      }

      fs.mkdirSync(casoOutDir, { recursive: true });
      const relPath = `out/${safeCaso}/ENVIO-SIMULADO.md`;
      const absPath = path.join(ctx.directory, relPath);

      const content = [
        `# ENVÍO SIMULADO DE PAQUETE DE PROVEEDOR`,
        ``,
        `- **Caso:** \`${caso}\``,
        `- **Timestamp de confirmación humana:** \`${new Date().toISOString()}\``,
        `- **Sesión:** \`${ctx.sessionId}\``,
        `- **Confirmado explícitamente por analista:** \`true\``,
        `- **Paquete asociado:** \`out/${caso}/paquete/\``,
      ].join("\n");

      fs.writeFileSync(absPath, content + "\n", "utf8");
      const resumen = `Envío simulado registrado en ${relPath} tras confirmación explícita del usuario.`;
      appendAuditLog(ctx.directory, caso, toolName, true, resumen);

      return JSON.stringify({
        ok: true,
        data: { ruta: relPath },
      });
    } catch (err) {
      const msg = `Error simulando envío: ${err instanceof Error ? err.message : String(err)}`;
      appendAuditLog(ctx.directory, rawArgs?.caso, toolName, false, msg);
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

export const proveedorTools = {
  proveedor_leer_solicitud: leer_solicitud,
  proveedor_mapear_campos: mapear_campos,
  proveedor_generar_formulario: generar_formulario,
  proveedor_armar_paquete: armar_paquete,
  proveedor_simular_envio: simular_envio,
};
