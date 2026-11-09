package niimblue

import (
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"strings"
	"sync"
	"testing"
	"time"
)

// eventSeq records events in order.
type eventSeq struct {
	mu     sync.Mutex
	events []recordedEvent
}

type recordedEvent struct {
	name    string
	payload json.RawMessage
}

func recordSeq(p *Printer) *eventSeq {
	s := &eventSeq{}
	p.OnEvent(func(name string, payload json.RawMessage) {
		s.mu.Lock()
		s.events = append(s.events, recordedEvent{name, append(json.RawMessage(nil), payload...)})
		s.mu.Unlock()
	})
	return s
}

func (s *eventSeq) all(names ...string) []recordedEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []recordedEvent
	for _, e := range s.events {
		for _, n := range names {
			if e.name == n {
				out = append(out, e)
			}
		}
	}
	return out
}

// connectFake connects to a stateful fake B1 over the custom transport.
func connectFake(t *testing.T) (*Printer, *fakePrinter) {
	t.Helper()
	p := newPrinter(t)
	fp := newFakePrinter(t, b1Dump)
	if _, err := p.ConnectCustom(func(d []byte) error {
		if r := fp.respond(d); r != nil {
			p.Feed(r)
		}
		return nil
	}, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	return p, fp
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func jobState(t *testing.T, p *Printer, id int) JobState {
	t.Helper()
	j, err := p.Job(id)
	if err != nil {
		t.Fatalf("Job(%d): %v", id, err)
	}
	return j.State
}

// solidImage: w x h image with a black square, so different sizes encode differently.
func solidImage(w, h int) *image.Gray {
	img := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := uint8(255)
			if x > 2 && y > 2 && x < w-2 && y < h-2 {
				c = 0
			}
			img.SetGray(x, y, color.Gray{Y: c})
		}
	}
	return img
}

// checkJobsContiguous fails if print jobs interleave: every PrintStart must be
// followed by its PrintEnd before the next PrintStart. Returns the job count.
func checkJobsContiguous(t *testing.T, fp *fakePrinter) int {
	t.Helper()
	jobs := 0
	inJob := false
	for i, c := range fp.commands() {
		switch c {
		case cmdPrintStart:
			if inJob {
				t.Fatalf("frame %d: PrintStart inside another job (interleaved jobs)", i)
			}
			inJob = true
			jobs++
		case cmdPrintEnd:
			if !inJob {
				t.Fatalf("frame %d: PrintEnd outside a job", i)
			}
			inJob = false
		case cmdPageEnd, cmdSetPageSize:
			if !inJob {
				t.Fatalf("frame %d: page command 0x%02x outside a job", i, c)
			}
		}
	}
	if inJob {
		t.Fatal("last job not ended")
	}
	return jobs
}

func TestConcurrentPrintsAreSerialized(t *testing.T) {
	p, fp := connectFake(t)

	const n = 6
	var wg sync.WaitGroup
	results := make(chan *PrintResult, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := p.Print(solidImage(40+i*8, 32), fastPoll)
			if err != nil {
				errs <- err
				return
			}
			results <- res
		}(i)
	}
	wg.Wait()
	close(errs)
	close(results)
	for err := range errs {
		t.Error(err)
	}

	ids := map[int]bool{}
	for r := range results {
		if r.JobID <= 0 || ids[r.JobID] {
			t.Errorf("bad or duplicate job id in %+v", r)
		}
		ids[r.JobID] = true
	}
	if got := checkJobsContiguous(t, fp); got != n {
		t.Errorf("fake printer saw %d jobs, want %d", got, n)
	}

}

func TestPrintBatch(t *testing.T) {
	p, fp := connectFake(t)
	ev := recordSeq(p)

	res, err := p.PrintBatch([]Page{
		{Image: solidImage(48, 24), Quantity: 1},
		{Image: solidImage(64, 32), Quantity: 2},
		{Image: testImage(), Quantity: 3},
	}, &PrintOptions{StatusPollIntervalMs: 20, Label: "batch"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Pages != 6 || len(res.Images) != 3 || res.JobID <= 0 {
		t.Fatalf("result %+v", res)
	}
	want := []PageResult{{48, 24, 1}, {64, 32, 2}, {120, 64, 3}}
	for i, w := range want {
		if res.Images[i] != w {
			t.Errorf("image %d = %+v, want %+v", i, res.Images[i], w)
		}
	}

	// One job: one PrintStart declaring 6 pages, three pages with their copies.
	starts := fp.framesOf(cmdPrintStart)
	if len(starts) != 1 || len(starts[0]) < 2 || int(starts[0][0])<<8|int(starts[0][1]) != 6 {
		t.Errorf("PrintStart frames %x, want one with totalPages 6", starts)
	}
	var copies []int
	for _, d := range fp.framesOf(cmdSetPageSize) {
		copies = append(copies, int(d[4])<<8|int(d[5]))
	}
	if len(copies) != 3 || copies[0] != 1 || copies[1] != 2 || copies[2] != 3 {
		t.Errorf("page copies %v, want [1 2 3]", copies)
	}
	checkJobsContiguous(t, fp)

	// Job snapshot
	j, err := p.Job(res.JobID)
	if err != nil || j.State != JobDone || j.Pages != 3 || j.TotalPages != 6 || j.Label != "batch" {
		t.Errorf("job %+v %v", j, err)
	}
	if j.FinishedAt().Before(j.StartedAt()) || j.StartedAt().Before(j.CreatedAt()) {
		t.Errorf("job times %v %v %v", j.CreatedAt(), j.StartedAt(), j.FinishedAt())
	}

	// Progress events of the batch carry its job id
	var prog struct {
		JobID      int `json:"jobId"`
		PagesTotal int `json:"pagesTotal"`
	}
	last := ev.all("printprogress")
	if len(last) == 0 {
		t.Fatal("no printprogress events")
	}
	_ = json.Unmarshal(last[len(last)-1].payload, &prog)
	if prog.JobID != res.JobID || prog.PagesTotal != 6 {
		t.Errorf("last progress %s", last[len(last)-1].payload)
	}
}

func TestPrintBatchPerPageOptions(t *testing.T) {
	p, _ := connectFake(t)
	// Page direction "left" rotates the page: 120x64 becomes 64 cols x 120 rows.
	res, err := p.PrintBatch([]Page{
		{Image: testImage()},
		{Image: testImage(), PrintDirection: "left"},
	}, &PrintOptions{Quantity: 2, StatusPollIntervalMs: 20})
	if err != nil {
		t.Fatal(err)
	}
	if res.Pages != 4 || res.Images[0] != (PageResult{120, 64, 2}) || res.Images[1] != (PageResult{64, 120, 2}) {
		t.Errorf("result %+v", res)
	}
}

func TestSubmitAndWaitJob(t *testing.T) {
	p, _ := connectFake(t)

	j, err := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	if err != nil {
		t.Fatal(err)
	}
	if j.ID <= 0 || (j.State != JobQueued && j.State != JobPrinting) || j.TotalPages != 1 {
		t.Fatalf("submitted job %+v", j)
	}

	done, err := p.WaitJob(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if done.State != JobDone || done.FinishedAtMs == 0 {
		t.Errorf("waited job %+v", done)
	}
	r, err := done.PrintResult()
	if err != nil || r.Pages != 1 || len(r.Images) != 1 {
		t.Errorf("job result %+v %v", r, err)
	}

	// Waiting again for a finished job returns at once
	if again, err := p.WaitJob(j.ID); err != nil || again.State != JobDone {
		t.Errorf("second wait %+v %v", again, err)
	}
	if _, err := p.WaitJob(99999); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("wait unknown job: %v", err)
	}
}

func TestCancelJob(t *testing.T) {
	p, fp := connectFake(t)

	// A printing job (held by the printer) keeps the others queued.
	fp.hold.Store(true)
	first, err := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "first job printing", func() bool { return jobState(t, p, first.ID) == JobPrinting })

	// A blocking caller whose job gets cancelled receives an error.
	blockingErr := make(chan error, 1)
	go func() {
		_, err := p.Print(testImage(), fastPoll)
		blockingErr <- err
	}()
	var blockingID int
	waitUntil(t, "blocking job queued", func() bool {
		jobs, _ := p.Jobs()
		for _, j := range jobs {
			if j.ID != first.ID && j.State == JobQueued {
				blockingID = j.ID
				return true
			}
		}
		return false
	})

	if _, err := p.CancelJob(first.ID); err == nil || !strings.Contains(err.Error(), "printing") {
		t.Errorf("cancel printing job: %v", err)
	}

	c, err := p.CancelJob(blockingID)
	if err != nil || c.State != JobCancelled {
		t.Fatalf("cancel queued job: %+v %v", c, err)
	}
	select {
	case err := <-blockingErr:
		if err == nil || !strings.Contains(err.Error(), "cancelled") {
			t.Errorf("blocking caller got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocking caller not released by cancel")
	}
	if _, err := p.WaitJob(blockingID); err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("wait cancelled job: %v", err)
	}
	if _, err := p.CancelJob(blockingID); err == nil || !strings.Contains(err.Error(), "already finished") {
		t.Errorf("cancel twice: %v", err)
	}

	fp.hold.Store(false)
	if j, err := p.WaitJob(first.ID); err != nil || j.State != JobDone {
		t.Errorf("first job %+v %v", j, err)
	}
	if got := checkJobsContiguous(t, fp); got != 1 {
		t.Errorf("printer saw %d jobs, want 1 (cancelled job must not print)", got)
	}
}

func TestClearQueueAndPause(t *testing.T) {
	p, fp := connectFake(t)

	if err := p.PauseQueue(); err != nil {
		t.Fatal(err)
	}
	if paused, _ := p.QueuePaused(); !paused {
		t.Error("not paused")
	}
	var ids []int
	for i := 0; i < 3; i++ {
		j, err := p.Submit([]Page{{Image: testImage()}}, fastPoll)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, j.ID)
	}

	// Paused: nothing starts
	time.Sleep(150 * time.Millisecond)
	for _, id := range ids {
		if s := jobState(t, p, id); s != JobQueued {
			t.Errorf("job %d is %s while paused", id, s)
		}
	}
	if n := len(fp.framesOf(cmdPrintStart)); n != 0 {
		t.Errorf("printer got %d PrintStart while paused", n)
	}

	n, err := p.ClearQueue()
	if err != nil || n != 3 {
		t.Fatalf("ClearQueue = %d, %v", n, err)
	}
	for _, id := range ids {
		if s := jobState(t, p, id); s != JobCancelled {
			t.Errorf("job %d is %s after clear", id, s)
		}
	}

	// Resume: new jobs print again
	j, err := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if s := jobState(t, p, j.ID); s != JobQueued {
		t.Errorf("job started while paused: %s", s)
	}
	if err := p.ResumeQueue(); err != nil {
		t.Fatal(err)
	}
	if done, err := p.WaitJob(j.ID); err != nil || done.State != JobDone {
		t.Errorf("after resume: %+v %v", done, err)
	}

	jobs, err := p.Jobs()
	if err != nil || len(jobs) != 4 {
		t.Fatalf("Jobs = %d %v", len(jobs), err)
	}
	for i := 1; i < len(jobs); i++ {
		if jobs[i].ID < jobs[i-1].ID {
			t.Errorf("jobs not in order: %v", jobs)
		}
	}
	if got := checkJobsContiguous(t, fp); got != 1 {
		t.Errorf("printer saw %d jobs, want 1", got)
	}
}

func TestPauseLetsRunningJobFinish(t *testing.T) {
	p, fp := connectFake(t)
	fp.hold.Store(true)
	a, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	b, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	waitUntil(t, "job a printing", func() bool { return jobState(t, p, a.ID) == JobPrinting })

	if err := p.PauseQueue(); err != nil {
		t.Fatal(err)
	}
	fp.hold.Store(false)
	if j, err := p.WaitJob(a.ID); err != nil || j.State != JobDone {
		t.Fatalf("running job after pause: %+v %v", j, err)
	}
	time.Sleep(100 * time.Millisecond)
	if s := jobState(t, p, b.ID); s != JobQueued {
		t.Errorf("job b is %s while paused", s)
	}
	_ = p.ResumeQueue()
	if j, err := p.WaitJob(b.ID); err != nil || j.State != JobDone {
		t.Errorf("job b after resume: %+v %v", j, err)
	}
}

func TestJobEvents(t *testing.T) {
	p, _ := connectFake(t)
	ev := recordSeq(p)

	res, err := p.Print(testImage(), &PrintOptions{StatusPollIntervalMs: 20, Label: "evt"})
	if err != nil {
		t.Fatal(err)
	}

	jobEvents := ev.all("jobqueued", "jobstarted", "jobdone")
	if len(jobEvents) != 3 || jobEvents[0].name != "jobqueued" || jobEvents[1].name != "jobstarted" ||
		jobEvents[2].name != "jobdone" {
		t.Fatalf("job events %v", jobEvents)
	}
	var queued, started Job
	_ = json.Unmarshal(jobEvents[0].payload, &queued)
	_ = json.Unmarshal(jobEvents[1].payload, &started)
	if queued.ID != res.JobID || queued.State != JobQueued || queued.Label != "evt" || started.State != JobPrinting {
		t.Errorf("queued %+v started %+v", queued, started)
	}
	var done JobEvent
	_ = json.Unmarshal(jobEvents[2].payload, &done)
	if done.ID != res.JobID || done.State != JobDone || len(done.Result) == 0 {
		t.Errorf("jobdone %s", jobEvents[2].payload)
	}

	for _, name := range []string{"printprogress", "printpacketprogress", "printend"} {
		list := ev.all(name)
		if len(list) == 0 {
			t.Errorf("no %s events", name)
			continue
		}
		var tagged struct {
			JobID int `json:"jobId"`
		}
		_ = json.Unmarshal(list[0].payload, &tagged)
		if tagged.JobID != res.JobID {
			t.Errorf("%s without jobId: %s", name, list[0].payload)
		}
	}

	// Heartbeat and other events are not tagged
	if _, err := p.Heartbeat(); err != nil {
		t.Fatal(err)
	}
}

func TestDisconnectFailsQueuedJobs(t *testing.T) {
	p, fp := connectFake(t)
	fp.hold.Store(true)

	running, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	waitUntil(t, "job printing", func() bool { return jobState(t, p, running.ID) == JobPrinting })
	queued, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)

	blockingErr := make(chan error, 1)
	go func() {
		_, err := p.Print(testImage(), fastPoll)
		blockingErr <- err
	}()
	waitUntil(t, "3 jobs", func() bool { jobs, _ := p.Jobs(); return len(jobs) == 3 })

	if err := p.Disconnect(); err != nil {
		t.Fatal(err)
	}

	if _, err := p.WaitJob(queued.ID); err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Errorf("queued job after disconnect: %v", err)
	}
	select {
	case err := <-blockingErr:
		if err == nil || !strings.Contains(err.Error(), "disconnected") {
			t.Errorf("blocking caller after disconnect: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocking caller not released by disconnect")
	}
	// The printing job fails on its own (transport closed)
	if j, err := p.WaitJob(running.ID); err == nil {
		t.Errorf("running job after disconnect: %+v %v", j, err)
	}
	if s := jobState(t, p, running.ID); s != JobFailed {
		t.Errorf("running job state %s", s)
	}
}

func TestDeviceCloseFailsQueuedJobs(t *testing.T) {
	p, fp := connectFake(t)
	fp.hold.Store(true)
	running, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	waitUntil(t, "job printing", func() bool { return jobState(t, p, running.ID) == JobPrinting })
	queued, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)

	p.TransportClosed()
	if _, err := p.WaitJob(queued.ID); err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Errorf("queued job after device close: %v", err)
	}
	if _, err := p.WaitJob(running.ID); err == nil {
		t.Error("running job survived device close")
	}
}

func TestReconnectFailsQueuedJobs(t *testing.T) {
	p, fp := connectFake(t)
	fp.hold.Store(true)
	running, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)
	waitUntil(t, "job printing", func() bool { return jobState(t, p, running.ID) == JobPrinting })
	queued, _ := p.Submit([]Page{{Image: testImage()}}, fastPoll)

	if _, err := p.ConnectVirtual(b1Dump, noHeartbeat); err != nil {
		t.Fatal(err)
	}
	if _, err := p.WaitJob(queued.ID); err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Errorf("queued job after reconnect: %v", err)
	}
	// The new connection prints
	if res, err := p.Print(testImage(), fastPoll); err != nil || res.JobID <= queued.ID {
		t.Errorf("print after reconnect: %+v %v", res, err)
	}
}

func TestBatchValidation(t *testing.T) {
	p, fp := connectFake(t)
	before, _ := p.Jobs()

	// Page 2 pixel buffer is too small for its size: rejected at submit, nothing queued.
	gray := json.RawMessage(`{"format":"gray"}`)
	_, err := p.printBatchRaw([]RawPage{
		{Pixels: make([]byte, 10*10), Width: 10, Height: 10, Options: gray},
		{Pixels: make([]byte, 10), Width: 10, Height: 10, Options: gray},
	}, fastPoll)
	if !errors.Is(err, ErrOperation) || !strings.Contains(err.Error(), "page 2") || !strings.Contains(err.Error(), "too small") {
		t.Errorf("short page buffer: %v", err)
	}

	_, err = p.printBatchRaw([]RawPage{{Pixels: make([]byte, 100), Width: 0, Height: 10, Options: gray}}, fastPoll)
	if err == nil || !strings.Contains(err.Error(), "page 1") {
		t.Errorf("zero width: %v", err)
	}

	_, err = p.PrintBatch([]Page{{Image: testImage(), Quantity: -1}}, fastPoll)
	if err == nil || !strings.Contains(err.Error(), "quantity") {
		t.Errorf("negative quantity: %v", err)
	}

	if _, err := p.PrintBatch(nil, fastPoll); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("no pages: %v", err)
	}
	if _, err := p.PrintBatch([]Page{{}}, fastPoll); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("nil image: %v", err)
	}
	if _, err := p.PrintBatch([]Page{{Image: testImage()}}, &PrintOptions{PrintTask: "NOPE"}); err == nil ||
		!strings.Contains(err.Error(), "unknown print task") {
		t.Errorf("bad task: %v", err)
	}

	after, _ := p.Jobs()
	if len(after) != len(before) {
		t.Errorf("invalid batches created jobs: %v", after)
	}
	if n := len(fp.framesOf(cmdPrintStart)); n != 0 {
		t.Errorf("printer got %d PrintStart for invalid batches", n)
	}
}

func TestPrintNotConnected(t *testing.T) {
	p := newPrinter(t)
	if _, err := p.Submit([]Page{{Image: testImage()}}, nil); err == nil || !strings.Contains(err.Error(), "Not connected") {
		t.Errorf("submit without printer: %v", err)
	}
	if jobs, err := p.Jobs(); err != nil || len(jobs) != 0 {
		t.Errorf("jobs %v %v", jobs, err)
	}
}

func TestTemplatePrintIsQueued(t *testing.T) {
	p, fp := connectFake(t)

	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var err error
			if i == 0 {
				var r *TemplatePrintResult
				r, err = p.PrintTemplate(assetTag, []map[string]string{assetData}, &TemplatePrintOptions{StatusPollIntervalMs: 20})
				if err == nil && r.JobID <= 0 {
					t.Errorf("template result without job id: %+v", r)
				}
			} else {
				_, err = p.Print(testImage(), fastPoll)
			}
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	if got := checkJobsContiguous(t, fp); got != 3 {
		t.Errorf("printer saw %d jobs, want 3", got)
	}
}
