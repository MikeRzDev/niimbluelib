//! cargo run --example info -- [serial-port]
//! Without a port: lists ports and the supported print tasks.
fn main() -> Result<(), niimblue::Error> {
    println!("libniimblue {} (niimbluelib {})", niimblue::version(), niimblue::niimbluelib_version());
    println!("serial ports: {}", niimblue::list_serial_ports());

    let printer = niimblue::Printer::new()?;
    printer.set_event_handler(|name, json| eprintln!("event {name}: {json}"));
    println!("print tasks: {}", printer.call("listPrintTasks", None)?);

    if let Some(port) = std::env::args().nth(1) {
        println!("connected: {}", printer.connect_serial(&port, Some(r#"{"heartbeat":false}"#))?);
        println!("heartbeat: {}", printer.call("fetchHeartbeat", None)?);
        printer.disconnect()?;
    }
    Ok(())
}
