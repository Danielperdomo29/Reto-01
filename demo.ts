import * as fs from "node:fs";
import * as path from "node:path";
import {
  leer_solicitud,
  mapear_campos,
  generar_formulario,
  armar_paquete,
  simular_envio,
} from "./src/tools/proveedor.js";

async function runDemo() {
  const directory = process.cwd();
  const outDir = path.join(directory, "out");

  // Requisito No Funcional (Seccion 8): out/ se limpia al inicio para determinismo
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const casosDir = path.join(directory, "fixtures", "reto-01", "casos");
  if (!fs.existsSync(casosDir)) {
    console.error(`No se encontro el directorio de casos en: ${casosDir}`);
    process.exit(1);
  }

  const casos = fs
    .readdirSync(casosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log("=================================================================");
  console.log("  DEMO DETERMINISTA RETO 01 -- REGISTRO COMO PROVEEDOR (SIN LLM)  ");
  console.log("=================================================================\n");

  const ctx = { directory, sessionId: "demo-determinista" };

  for (const caso of casos) {
    console.log(`PROCESANDO CASO: ${caso}`);
    console.log("-----------------------------------------------------------------");

    // 1. Leer solicitud
    const rLectura = JSON.parse(await leer_solicitud.execute({ caso }, ctx));
    if (!rLectura.ok) {
      console.log(`  [ERROR LECTURA]: ${rLectura.error}\n`);
      continue;
    }
    const { cliente, pais, formato, campos, soportes } = rLectura.data;
    console.log(`  Cliente:          ${cliente} (${pais})`);
    console.log(`  Formato pedido:   ${formato}`);
    console.log(`  Campos pedidos:   ${campos.length}`);
    console.log(`  Soportes pedidos: ${soportes.join(", ")}`);

    // 2. Mapear campos
    const rMapeo = JSON.parse(
      await mapear_campos.execute({ caso, campos }, ctx)
    );
    const { llenos, requiere_confirmacion, faltantes } = rMapeo.data;
    console.log(
      `  Mapeo al maestro: ${llenos.length} llenos | ${requiere_confirmacion.length} requieren confirmacion | ${faltantes.length} faltantes`
    );
    if (requiere_confirmacion.length > 0) {
      for (const rc of requiere_confirmacion) {
        console.log(`    [!] Confirmar '${rc.etiqueta}' -> '${rc.valor}' (${rc.nota})`);
      }
    }
    if (faltantes.length > 0) {
      console.log(
        `    [?] Faltantes: ${faltantes.map((f: { etiqueta: string }) => f.etiqueta).join(", ")}`
      );
    }

    // 3. Generar formulario
    const rForm = JSON.parse(
      await generar_formulario.execute({ caso, mapeo: rMapeo.data }, ctx)
    );
    console.log(
      `  Formulario:       ${rForm.data.ruta} (${
        rForm.data.estado_formato || rForm.data.formato
      })`
    );

    // 4. Armar paquete
    const rPaquete = JSON.parse(await armar_paquete.execute({ caso }, ctx));
    const { ruta, listo_para_firma, checklist } = rPaquete.data;
    console.log(`  Paquete armado:   ${ruta}`);
    console.log(
      `  Listo para firma: ${listo_para_firma ? "SI [OK]" : "NO [BLOQUEADO POR SOPORTES RN3]"}`
    );
    if (checklist.soportes_vencidos.length > 0) {
      console.log(
        `    [X] Soportes vencidos: ${checklist.soportes_vencidos
          .map((s: { tipo: string; vigencia_hasta: string }) => `${s.tipo} (vencio ${s.vigencia_hasta})`)
          .join(", ")}`
      );
    }
    if (checklist.soportes_ausentes.length > 0) {
      console.log(
        `    [X] Soportes ausentes: ${checklist.soportes_ausentes.join(", ")}`
      );
    }

    // 5. Verificar bloqueo de envio sin confirmacion explicita (RN4)
    const rEnvioSinConfirmar = JSON.parse(
      await simular_envio.execute({ caso, confirmado: false }, ctx)
    );
    console.log(
      `  Control RN4 (confirmado=false): ok=${rEnvioSinConfirmar.ok} (${rEnvioSinConfirmar.error})`
    );
    console.log("");
  }

  console.log("=================================================================");
  console.log("  DEMO FINALIZADA -- Revisa la carpeta out/ y out/log.jsonl");
  console.log("=================================================================");
}

runDemo();
