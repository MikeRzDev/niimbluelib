package io.github.multimote.niimblue.example;

import io.github.multimote.niimblue.NiimException;
import io.github.multimote.niimblue.NiimPrinter;

import java.nio.file.Files;
import java.nio.file.Path;

/** Renders and prints (on the virtual B1) a template: Main <template.niim> <b1_print_dump.txt> */
public final class Main {
    public static void main(String[] args) throws Exception {
        byte[] template = Files.readAllBytes(Path.of(args[0]));
        String dump = Files.readString(Path.of(args[1]));
        String data = "{\"uuid\":\"794ad7ca-1ae2-451e-b06a-d93fd303e9d9\",\"asset_name\":\"Oppenheimer\","
                + "\"asset_type\":\"Compute Node\",\"site\":\"Manhattan\"}";

        System.out.println("libniimblue " + NiimPrinter.version() + ", niimbluelib " + NiimPrinter.niimbluelibVersion());
        try (NiimPrinter printer = new NiimPrinter()) {
            printer.setEventListener((name, json) -> {
                if (name.equals("printend")) System.out.println("event: printend");
            });
            String rendered = printer.renderTemplate(template, data);
            System.out.println("rendered " + rendered.substring(0, rendered.indexOf(",\"pixels\"")) + "}");
            printer.connectVirtual(dump, "{\"heartbeat\":false}");
            System.out.println("printed " + printer.printTemplate(template, data, "{\"statusPollIntervalMs\":20}"));
            try {
                printer.call("noSuchMethod");
            } catch (NiimException e) {
                System.out.println("error " + e.getCode() + ": " + e.getMessage());
            }
        }
    }
}
