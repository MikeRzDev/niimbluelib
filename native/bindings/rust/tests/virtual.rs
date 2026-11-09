//! No printer needed: the virtual printer replays a recorded B1 session.
//! Same fixtures as the Go tests (native/go/testdata).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use niimblue::{ErrorKind, Page, Printer};

const B1_DUMP: &str = include_str!("../../../go/testdata/b1_print_dump.txt");
const ASSET_TAG: &[u8] = include_bytes!("../../../go/testdata/asset-tag.niim");
const ASSET_DATA: &str =
    r#"{"uuid":"794ad7ca-1ae2-451e-b06a-d93fd303e9d9","asset_name":"Oppenheimer","asset_type":"Compute Node","site":"Manhattan"}"#;
const NO_HEARTBEAT: Option<&str> = Some(r#"{"heartbeat":false}"#);

fn field<'a>(json: &'a str, name: &str) -> &'a str {
    let key = format!("\"{name}\":");
    let start = json.find(&key).unwrap_or_else(|| panic!("no {name} in {json}")) + key.len();
    let rest = json[start..].trim_start_matches('"');
    let end = rest.find([',', '}', '"']).unwrap();
    &rest[..end]
}

#[test]
fn versions() {
    assert!(!niimblue::version().is_empty());
    assert!(niimblue::niimbluelib_version().starts_with(|c: char| c.is_ascii_digit()));
    assert!(niimblue::list_serial_ports().starts_with('['));
}

#[test]
fn render_template() {
    let p = Printer::new().unwrap();
    let out = p.render_template(ASSET_TAG, Some(ASSET_DATA), None).unwrap();
    assert_eq!(field(&out, "width"), "240");
    assert_eq!(field(&out, "height"), "160");
    assert_eq!(field(&out, "printDirection"), "top");
    let b64 = field(&out, "pixels");
    assert_eq!(b64.len(), (240 * 160 * 4usize).div_ceil(3) * 4);
}

#[test]
fn template_tags() {
    let p = Printer::new().unwrap();
    let tags = p.call_binary("templateTags", None, Some(ASSET_TAG)).unwrap();
    assert_eq!(tags, r#"["uuid","asset_name","asset_type","site"]"#);
    // Only .niim packages, not template JSON
    let err = p.template_tags(br#"{"format":"niimblue-template"}"#).unwrap_err();
    assert!(err.message.contains(".niim template package"), "{err}");
}

#[test]
fn print_template_on_virtual_printer() {
    let p = Printer::new().unwrap();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let ev = events.clone();
    p.set_event_handler(move |name, _| ev.lock().unwrap().push(name.to_string()));

    let err = p.print_template(ASSET_TAG, Some(ASSET_DATA), None).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Operation);

    let info = p.connect_virtual(B1_DUMP, NO_HEARTBEAT).unwrap();
    assert_eq!(field(&info, "printTask"), "B1");
    let res = p
        .print_template(ASSET_TAG, Some(&format!("[{ASSET_DATA}]")), Some(r#"{"statusPollIntervalMs":20}"#))
        .unwrap();
    assert_eq!(field(&res, "labels"), "1");
    assert_eq!(field(&res, "pages"), "1");
    let names = events.lock().unwrap().clone();
    assert!(names.iter().any(|n| n == "connect") && names.iter().any(|n| n == "printend"), "{names:?}");

    let err = p.print_template(ASSET_TAG, Some(&format!(r#"[{ASSET_DATA},{{"uuid":"x"}}]"#)), None).unwrap_err();
    assert!(err.message.contains("asset_name"), "{err}");
    p.disconnect().unwrap();
}

#[test]
fn unicode_round_trip() {
    let p = Printer::new().unwrap();
    let method = "nö-such-mëthod-😀";
    let err = p.call(method, None).unwrap_err();
    assert!(err.message.ends_with(method), "{err}");
    assert_eq!(p.call("a\0b", None).unwrap_err().kind, ErrorKind::InvalidArgument);
}

#[test]
fn reentrant_call_fails() {
    let p = Arc::new(Printer::new().unwrap());
    let kinds = Arc::new(Mutex::new(Vec::new()));
    let (weak, k) = (Arc::downgrade(&p), kinds.clone());
    p.set_event_handler(move |name, _| {
        if name == "connect" {
            if let Some(p) = weak.upgrade() {
                k.lock().unwrap().push(p.call("isConnected", None).map_err(|e| e.kind));
            }
        }
    });
    p.connect_virtual(B1_DUMP, NO_HEARTBEAT).unwrap();
    p.clear_event_handler(); // drop the handler's Weak before p
    assert_eq!(*kinds.lock().unwrap(), vec![Err(ErrorKind::Reentrant)]);
}

#[test]
fn swap_handlers_while_events_fire() {
    let p = Arc::new(Printer::new().unwrap());
    let b = Arc::new(AtomicUsize::new(0));
    let install_b = {
        let b = b.clone();
        move |p: &Printer| {
            let b = b.clone();
            p.set_event_handler(move |_, _| {
                b.fetch_add(1, Ordering::Relaxed);
            })
        }
    };
    {
        let weak = Arc::downgrade(&p);
        let install_b = install_b.clone();
        p.set_event_handler(move |name, _| {
            if name == "heartbeat" {
                if let Some(p) = weak.upgrade() {
                    install_b(&p); // from inside a handler
                }
            }
        });
    }
    p.connect_virtual(B1_DUMP, Some(r#"{"heartbeatIntervalMs":10}"#)).unwrap();
    let end = Instant::now() + Duration::from_millis(300);
    let mut i = 0;
    while Instant::now() < end {
        match i % 3 {
            0 => p.set_event_handler(|_, _| {}),
            1 => p.clear_event_handler(),
            _ => install_b(&p),
        }
        i += 1;
        std::thread::sleep(Duration::from_millis(1));
    }
    install_b(&p);
    let before = b.load(Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(150));
    assert!(b.load(Ordering::Relaxed) > before, "last handler got no events");
}

#[test]
fn custom_transport_runs_on_library_thread() {
    let p = Printer::new().unwrap();
    let caller = std::thread::current().id();
    let writes = Arc::new(Mutex::new(Vec::new()));
    let w = writes.clone();
    let err = p
        .connect_custom(
            move |_data| {
                w.lock().unwrap().push(std::thread::current().id());
                false // fail every write
            },
            NO_HEARTBEAT,
        )
        .unwrap_err();
    let threads = writes.lock().unwrap().clone();
    assert!(!threads.is_empty());
    assert!(threads.iter().all(|t| *t != caller));
    assert!(matches!(err.kind, ErrorKind::Operation | ErrorKind::Transport), "{err}");
}

#[test]
fn parallel_printers() {
    let handles: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(|| {
                let p = Printer::new().unwrap();
                p.connect_virtual(B1_DUMP, NO_HEARTBEAT).unwrap();
                for _ in 0..3 {
                    p.render_template(ASSET_TAG, Some(ASSET_DATA), None).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

/// 120x64 gray checkerboard (0 = black)
fn gray_image() -> Vec<u8> {
    (0..64u32).flat_map(|y| (0..120u32).map(move |x| if (x / 8 + y / 8) % 2 == 0 { 0 } else { 255 })).collect()
}

#[test]
fn print_batch_and_queue() {
    let p = Printer::new().unwrap();
    p.connect_virtual(B1_DUMP, NO_HEARTBEAT).unwrap();
    let px = gray_image();
    let page = Page { pixels: &px, width: 120, height: 64, options: Some(r#"{"format":"gray"}"#) };
    let opts = Some(r#"{"statusPollIntervalMs":20}"#);

    // The virtual printer always reports "page 1 of 1": single page jobs only.
    let out = p.print_batch(&[page], opts).unwrap();
    assert_eq!(field(&out, "pages"), "1");
    assert_eq!(field(&out, "jobId"), "1");
    assert!(out.contains(r#""images":[{"cols":120,"rows":64,"quantity":1}]"#), "{out}");

    // Bad page 2 is rejected at submit
    let short = Page { pixels: &px[..10], ..page };
    let err = p.print_batch(&[page, short], opts).unwrap_err();
    assert!(err.message.contains("page 2") && err.message.contains("too small"), "{err}");
    let err = p.print_batch(&[], opts).unwrap_err();
    assert!(err.message.contains("no pages"), "{err}");

    // Submit + wait
    let job = p.submit(&[page], opts).unwrap();
    let id: i64 = field(&job, "id").parse().unwrap();
    let done = p.wait_job(id).unwrap();
    assert_eq!(field(&done, "state"), "done");
    assert_eq!(field(&p.job(id).unwrap(), "state"), "done");

    // Pause, queue, cancel, clear
    p.pause_queue().unwrap();
    let a: i64 = field(&p.submit(&[page], None).unwrap(), "id").parse().unwrap();
    let b: i64 = field(&p.submit(&[page], None).unwrap(), "id").parse().unwrap();
    assert_eq!(field(&p.job(a).unwrap(), "state"), "queued");
    assert_eq!(field(&p.cancel_job(a).unwrap(), "state"), "cancelled");
    assert_eq!(p.clear_queue().unwrap(), 1);
    let err = p.wait_job(b).unwrap_err();
    assert!(err.message.contains("cancelled"), "{err}");
    p.resume_queue().unwrap();
    assert!(p.jobs().unwrap().contains(&format!(r#""id":{b}"#)));
}

#[test]
fn png_printer() {
    let p = Printer::new().unwrap();
    let info = p.connect_png(Some(r#"{"model":"B1"}"#)).unwrap();
    assert_eq!(field(&info, "printTask"), "B1");
    let res = p.print_template(ASSET_TAG, Some(ASSET_DATA), Some(r#"{"statusPollIntervalMs":5}"#)).unwrap();
    let job: i64 = field(&res, "jobId").parse().unwrap();
    let pages = p.png_pages(Some(job)).unwrap();
    assert_eq!(field(&pages, "width"), "240");
    assert_eq!(field(&pages, "height"), "160");
    assert!(field(&pages, "png").starts_with("iVBORw0KGgo"), "not a PNG: {pages}");
    assert_eq!(p.clear_png_pages().unwrap(), 1);
}

// Methods generated from api/api.json, without a printer.
#[test]
fn generated_methods() {
    let p = Printer::new().unwrap();
    assert!(p.print_tasks().unwrap().contains("\"B1\""));
    assert!(!p.is_connected().unwrap());
    assert!(!p.queue_paused().unwrap());
    p.pause_queue().unwrap();
    assert!(p.queue_paused().unwrap());
    p.resume_queue().unwrap();
    assert_eq!(p.clear_queue().unwrap(), 0);
    assert!(p.printer_info().is_err());
    // Binary payload through niim_call_bin
    assert!(p.register_font("Junk", b"not a font", None, None).is_err());
    let tags = p.template_tags(ASSET_TAG).unwrap();
    assert_eq!(tags, r#"["uuid","asset_name","asset_type","site"]"#);
}
