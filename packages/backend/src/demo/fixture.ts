/**
 * Synthetic conversation for DEMO_MODE and tests. Deterministic: the same `now`
 * always yields the same messages. Vietnamese messages from 5 people about the
 * "Mèo Béo v2.0" project, as raw GraphChatMessage with HTML bodies:
 * - the last 12 days (~120 messages, dense): the release sprint — decisions,
 *   action items with owners and deadlines, a question/answer, off-topic chat,
 *   one <at> mention, one file attachment, one deleted message and one
 *   systemEventMessage, so the whole normalize/chunk pipeline is exercised;
 * - 13 to 120 days back (sparser, a few messages on most working days): v1.9
 *   feedback, then planning, design/QA (a design review with a clear decision
 *   and action items 57–53 days back = week 2 of August 2026 for the test clock
 *   06/10/2026), development, and a Sunday production incident 30 days back.
 * The fetcher honors range, maxMessages (newest first, truncated flag),
 * maxScanPages and deadline (pages of 50 scanned back from now, like a channel;
 * scanLimited when either stops it) and onPage(count, scannedBackTo).
 */

import type { ConversationSource, FetchOptions, FetchResult, GraphChatMessage, MessageFetcher, TimeRange } from '../types.ts'

export const DEMO_SOURCE: ConversationSource = { kind: 'demo', label: 'Nhóm demo: Dự án Mèo Béo' }

export interface DemoFetcherOptions {
  readonly now?: () => number
  /** Simulated latency per 50-message page, so the UI can show fetch progress. Default 0. */
  readonly pageDelayMs?: number
}

export function createDemoFetcher(options?: DemoFetcherOptions): MessageFetcher {
  const now = options?.now ?? Date.now
  const pageDelayMs = options?.pageDelayMs ?? 0
  return {
    async fetch(_source: ConversationSource, range: TimeRange, fetchOptions: FetchOptions): Promise<FetchResult> {
      const { signal, maxMessages, onPage } = fetchOptions
      const maxPages = Math.max(1, fetchOptions.maxScanPages ?? Number.POSITIVE_INFINITY)
      signal?.throwIfAborted()
      // Newest first, like Graph, so maxMessages keeps the latest messages.
      const all = demoMessages(now()).reverse()
      const messages: GraphChatMessage[] = []
      let truncated = false
      let scanLimited = false
      let exhausted = false
      let scannedBackTo = Number.POSITIVE_INFINITY
      for (let start = 0, pages = 0; start < all.length && !exhausted && !truncated; start += PAGE_SIZE, pages++) {
        if (pages >= maxPages || Date.now() >= (fetchOptions.deadline ?? Number.POSITIVE_INFINITY)) {
          truncated = scanLimited = true
          break
        }
        if (pageDelayMs > 0) await delay(pageDelayMs, signal)
        signal?.throwIfAborted()
        for (const message of all.slice(start, start + PAGE_SIZE)) {
          const time = Date.parse(message.createdDateTime)
          scannedBackTo = Math.min(scannedBackTo, time)
          if (time >= range.until) continue
          if (time < range.since) {
            exhausted = true
            break
          }
          if (messages.length >= maxMessages) {
            truncated = true
            break
          }
          messages.push(message)
        }
        // The listing ran out: nothing older exists, so the whole window was covered.
        if (start + PAGE_SIZE >= all.length) scannedBackTo = Math.min(scannedBackTo, range.since)
        onPage?.(messages.length, scannedBackTo)
      }
      return { messages, truncated, scanLimited, scannedBackTo }
    },
  }
}

const PAGE_SIZE = 50
const DAY_MS = 86_400_000
/** The script is written in Vietnam time (UTC+7, no DST). */
const ZONE_OFFSET_MS = 7 * 3_600_000
/** The anchor day's last message is at 09:20; before this, the script ends yesterday instead. */
const ANCHOR_CUTOFF_MINUTES = 9 * 60 + 30
/** Older history covers anchor days -HISTORY_DAYS .. -HISTORY_END. */
const HISTORY_DAYS = 120
const HISTORY_END = 13
/** Share of working days without scripted history that get 1–3 routine messages. */
const BUSY_DAY_RATE = 0.8

interface Person {
  readonly id: string
  readonly name: string
}

const PEOPLE: readonly Person[] = [
  { id: '6f1c2a10-0000-4000-8000-000000000001', name: 'Nguyễn Minh Anh' },
  { id: '6f1c2a10-0000-4000-8000-000000000002', name: 'Trần Quốc Bảo' },
  { id: '6f1c2a10-0000-4000-8000-000000000003', name: 'Phạm Đức Huy' },
  { id: '6f1c2a10-0000-4000-8000-000000000004', name: 'Lê Thu Hà' },
  { id: '6f1c2a10-0000-4000-8000-000000000005', name: 'Võ Ngọc Lan' },
]
const [ANH, BAO, HUY, HA, LAN] = [0, 1, 2, 3, 4] as const

type Special = 'mention-huy' | 'file' | 'deleted' | 'system'

/**
 * [day relative to the anchor day, "HH:mm" Vietnam time, speaker, HTML body, special].
 * "{+9}" in a body becomes the date (dd/MM) nine days after the anchor day, so
 * deadlines stay consistent with whenever the demo runs.
 */
type ScriptLine = readonly [day: number, time: string, who: number, html: string, special?: Special]

const SCRIPT: readonly ScriptLine[] = [
  [-12, '09:02', ANH, '<p>Chào cả nhà! Tuần này mình chính thức chạy nước rút cho bản <b>Mèo Béo v2.0</b> nhé <emoji id="rocket" alt="🚀" title="Rocket"></emoji></p>'],
  [-12, '09:04', BAO, '<p>Ok chị. API đặt lịch mới bên backend xong khoảng 80% rồi.</p>'],
  [-12, '09:06', HUY, '<p>Mobile còn màn hình thanh toán mới và dark mode chưa xong.</p>'],
  [-12, '09:07', LAN, '<p>Thiết kế dark mode em sẽ gửi bản final trong chiều nay ạ.</p>'],
  [-12, '09:10', HA, '<p>QA cần ít nhất 1 tuần regression trước khi release nha mọi người.</p>'],
  [-12, '09:15', ANH, '<p>Chị đề xuất mốc như sau:</p><ul><li>Code freeze: {+2}</li><li>Regression: {+3} → {+8}</li><li>Release: {+9}</li></ul><p>Mọi người góp ý trước ngày {-10} nhé.</p>'],
  [-12, '14:30', LAN, '<p>Đã up thiết kế dark mode lên Figma: <a href="https://www.figma.com/file/demo-meobeo-dark?node=1&amp;mode=dev">Figma – Dark mode</a></p>'],
  [-12, '14:45', HUY, '<p>Cảm ơn Lan, nhìn xịn quá <emoji id="heart_eyes" alt="😍" title="Heart eyes"></emoji></p>'],

  [-11, '09:00', BAO, '<p>Sáng nay staging bị lỗi 500 khi gọi API thanh toán, mình đang xem.</p>'],
  [-11, '09:20', BAO, '<p>Nguyên nhân: thiếu biến môi trường PAYMENT_KEY trên staging. Đã fix.</p>'],
  [-11, '09:22', HA, '<p>Mình test lại thấy ok rồi nhé.</p>'],
  [-11, '10:05', ANH, '<p>Nhắc lại: mỗi người cập nhật trạng thái task trên board trước 17h hằng ngày nhé.</p>'],
  [-11, '11:30', HUY, '<p>Màn hình thanh toán xong UI, còn tích hợp API.</p>'],
  [-11, '15:00', HA, '<p>Mình vừa log 3 bug mới:</p><ol><li>#231 Crash khi mở app lần đầu trên Android 10</li><li>#232 Sai font chữ ở dark mode</li><li>#233 Nút &quot;Đặt lịch&quot; bị che trên iPhone SE</li></ol>'],
  [-11, '15:10', ANH, '<p>Cảm ơn Hà. Sáng mai mình triage nhé.</p>'],
  [-11, '17:45', LAN, '<p>Có ai đi ăn bún chả không? <emoji id="yum" alt="😋" title="Yum"></emoji></p>'],
  [-11, '17:47', BAO, '<p>Mình đi! Hẹn 18h dưới sảnh.</p>'],

  [-10, '09:00', ANH, '<p><b>Triage bug</b> sáng nay:<br>- #231: P1, Huy nhận<br>- #232: P2, Lan &amp; Huy phối hợp<br>- #233: P2, Huy nhận</p>'],
  [-10, '09:05', HUY, '<p>Nhận ạ. #231 em xử lý trong hôm nay.</p>'],
  [-10, '09:06', LAN, '<p>#232 do em đặt sai token màu, em sửa trong file thiết kế rồi báo Huy.</p>'],
  [-10, '10:15', BAO, '<p>Anh hỏi chút: bản v2.0 có cần hỗ trợ iOS 15 không mọi người?</p>'],
  [-10, '10:20', ANH, '<p>Không em, v2.0 chỉ hỗ trợ iOS 16 trở lên, chị đã thống nhất với khách hàng.</p>'],
  [-10, '10:21', BAO, '<p>Ok, vậy anh bỏ được mấy đoạn workaround cũ.</p>'],
  [-10, '14:00', HUY, '<p>#231 fixed, do thiếu quyền thông báo trên Android 10. PR đã tạo.</p>'],
  [-10, '14:30', BAO, '<p>Đã review và merge PR của Huy.</p>'],
  [-10, '16:00', HA, '<p>Mình sẽ verify #231 sáng mai.</p>'],
  [-10, '16:30', ANH, '<p>Mọi người cho chị ý kiến về mốc release đề xuất hôm trước nhé.</p>'],
  [-10, '16:40', BAO, '<p>Backend ok với mốc đó.</p>'],
  [-10, '16:42', HUY, '<p>Mobile hơi căng nhưng cố được.</p>'],

  [-9, '09:10', HA, '<p>#231 verified trên 3 máy Android, đóng bug.</p>'],
  [-9, '09:30', LAN, '<p>Đã cập nhật token màu dark mode:</p><p>- Nền: #121212<br>- Chữ chính: #E6E6E6</p>'],
  [-9, '10:00', HUY, '<p>Cảm ơn Lan, em áp vào luôn.</p>'],
  [-9, '11:00', ANH, '<systemEventMessage/>', 'system'],
  [-9, '11:05', ANH, '<p>Chị vừa đổi tên nhóm thành &quot;Dự án Mèo Béo – Release v2.0&quot; cho dễ tìm.</p>'],
  [-9, '14:20', BAO, '<p>API thanh toán đã có rate limit 10 req/s mỗi user.</p>'],
  [-9, '14:25', HA, '<p>Mình cần tài khoản test có số dư để test thanh toán, ai cấp giúp với?</p>'],
  [-9, '14:40', BAO, '<p>Mình tạo 5 tài khoản test rồi, thông tin để trong vault của dự án nhé.</p>'],
  [-9, '15:00', HA, '<p>Cảm ơn anh Bảo.</p>'],
  [-9, '17:30', LAN, '<p>Chiều nay ai thấy con mèo của toà nhà không? Nó ngủ trên ghế phòng họp <emoji id="laugh" alt="😂" title="Laugh"></emoji></p>'],
  [-9, '17:32', HUY, '<p>Chắc nó cũng đang chờ release <emoji id="laugh" alt="😆" title="Laugh"></emoji></p>'],

  [-8, '09:00', ANH, '<p><b>Quyết định:</b> chốt ngày release v2.0 là <b>{+9}</b>, code freeze <b>{+2}</b>.</p>'],
  [-8, '09:02', BAO, '<p><emoji id="yes" alt="👍" title="Like"></emoji></p>'],
  [-8, '09:05', HA, '<p><at id="0">Phạm Đức Huy</at> em gửi bản build mới nhất lên TestFlight giúp chị trước 12h nhé.</p>', 'mention-huy'],
  [-8, '09:10', HUY, '<p>Dạ chị, 11h em gửi.</p>'],
  [-8, '11:05', HUY, '<p>Build 2.0.0 (45) đã lên TestFlight và Firebase.</p>'],
  [-8, '13:30', HA, '<p>Bắt đầu smoke test build 45.</p>'],
  [-8, '15:45', HA, '<p>Smoke test pass 18/20 case. 2 case fail liên quan đến push notification.</p>'],
  [-8, '15:50', BAO, '<p>Push notification do server gửi sai payload, mình sửa.</p>'],
  [-8, '17:10', BAO, '<p>Đã deploy bản sửa lên staging.</p>'],
  [-8, '17:20', HA, '<p>Retest pass rồi nhé.</p>'],

  [-7, '09:15', LAN, '<p>Mình đề xuất đổi icon app cho v2.0, mọi người xem 3 phương án trong Figma nhé.</p>'],
  [-7, '09:30', ANH, '<p>Chị thích phương án 2.</p>'],
  [-7, '09:31', BAO, '<p>Phương án 2 +1.</p>'],
  [-7, '09:40', HUY, '<p>Em cũng chọn 2.</p>'],
  [-7, '10:00', LAN, '<p>Ok, chốt icon phương án 2. Em xuất asset gửi Huy trước {-5}.</p>'],
  [-7, '11:00', HA, '', 'deleted'],
  [-7, '11:01', HA, '<p>Nhầm group, xin lỗi mọi người <emoji id="sweat" alt="😅" title="Sweat"></emoji></p>'],
  [-7, '14:00', ANH, '<p>Việc cần làm tuần này:</p><ul><li>Huy: hoàn thiện tích hợp thanh toán – hạn {-4}</li><li>Bảo: viết tài liệu API v2 – hạn {-3}</li><li>Hà: kế hoạch regression – hạn {-5}</li><li>Lan: asset icon mới – hạn {-5}</li></ul>'],
  [-7, '14:10', BAO, '<p>Ok chị.</p>'],
  [-7, '16:00', HUY, '<p>Thanh toán qua ví điện tử đã chạy trên staging.</p>'],

  [-6, '09:00', HA, '<p>Kế hoạch regression đây mọi người:</p><attachment id="demo-att-regression"></attachment>', 'file'],
  [-6, '09:20', ANH, '<p>Cảm ơn Hà, kế hoạch rất chi tiết.</p>'],
  [-6, '10:00', BAO, '<p>Trong kế hoạch có test tải cho API đặt lịch không Hà?</p>'],
  [-6, '10:10', HA, '<p>Có anh, mục 4.2: test tải 500 user đồng thời trên staging.</p>'],
  [-6, '11:30', HUY, '<p>Phát hiện memory leak ở màn hình bản đồ, đang điều tra.</p>'],
  [-6, '15:00', HUY, '<p>Leak do listener vị trí không được huỷ. Đã fix, PR #245.</p>'],
  [-6, '15:30', BAO, '<p>Merged.</p>'],
  [-6, '16:00', LAN, '<p>Asset icon mới đã gửi Huy qua Figma nhé.</p>'],
  [-6, '16:05', HUY, '<p>Nhận rồi, cảm ơn Lan.</p>'],
  [-6, '18:00', ANH, '<p>Cuối tuần mọi người nghỉ ngơi nhé, tuần sau căng đấy <emoji id="muscle" alt="💪" title="Muscle"></emoji></p>'],

  [-5, '10:00', BAO, '<p>Cuối tuần mà vẫn có alert từ staging, CPU 95%. Mình check rồi, do job đồng bộ chạy trùng. Đã tắt job thừa.</p>'],
  [-5, '10:30', HA, '<p>Cảm ơn anh, đúng lúc mình đang chạy test tải.</p>'],
  [-5, '21:00', LAN, '<p>Ai xem trận bóng tối nay không? <emoji id="smile" alt="😄" title="Smile"></emoji></p>'],
  [-5, '21:05', HUY, '<p>Có, hồi hộp quá!</p>'],

  [-4, '09:00', ANH, '<p>Tuần cuối trước code freeze. Mọi người báo cáo nhanh tiến độ nhé.</p>'],
  [-4, '09:05', BAO, '<p>Backend: xong 100% tính năng, còn viết tài liệu API (hạn {-3}).</p>'],
  [-4, '09:07', HUY, '<p>Mobile: thanh toán xong, đang fix 2 bug UI nhỏ.</p>'],
  [-4, '09:08', LAN, '<p>Design: đã bàn giao hết asset.</p>'],
  [-4, '09:10', HA, '<p>QA: test tải pass, đang chạy regression vòng 1.</p>'],
  [-4, '11:00', HA, '<p>Bug mới #250: ứng dụng bị đơ khi đổi ngôn ngữ sang tiếng Anh. Mức P1.</p>'],
  [-4, '11:05', ANH, '<p>Huy ưu tiên #250 nhé.</p>'],
  [-4, '11:06', HUY, '<p>Dạ em xử lý ngay.</p>'],
  [-4, '15:30', HUY, '<p>#250 đã fix, do vòng lặp render khi đổi locale.</p>'],
  [-4, '16:00', HA, '<p>Verify #250 ok.</p>'],
  [-4, '17:00', BAO, '<p>Tài liệu API v2 xong bản nháp, mọi người review giúp: <a href="https://wiki.example.com/meobeo/api-v2">API v2 docs</a></p>'],

  [-3, '09:00', ANH, '<p>Chị đã review tài liệu API, rất ổn. Cảm ơn Bảo.</p>'],
  [-3, '10:00', HA, '<p>Regression vòng 1: 142/150 pass, 8 fail (đã log bug).</p>'],
  [-3, '10:05', ANH, '<p>Có bug nào chặn release không Hà?</p>'],
  [-3, '10:15', HA, '<p>Có 1 bug chặn: <b>#257</b> mất dữ liệu lịch hẹn khi offline. Còn lại đều P3.</p>'],
  [-3, '10:20', BAO, '<p>#257 liên quan đồng bộ, để mình và Huy cùng xem.</p>'],
  [-3, '14:00', HUY, '<p>#257: đã thêm hàng đợi offline, đang test.</p>'],
  [-3, '16:30', BAO, '<p>#257 đã fix và merge. Hà verify giúp nhé.</p>'],
  [-3, '17:00', HA, '<p>Mai mình verify #257 đầu giờ.</p>'],

  [-2, '09:00', HA, '<p>#257 verify pass trên iOS và Android.</p>'],
  [-2, '09:10', ANH, '<p>Tuyệt! Vậy code freeze đúng hạn {+2} nhé. Sau code freeze chỉ merge bug P1.</p>'],
  [-2, '09:15', BAO, '<p>Đồng ý.</p>'],
  [-2, '11:00', LAN, '<p>Mình chuẩn bị xong ảnh chụp màn hình cho App Store &amp; Google Play rồi nhé.</p><p>Cần ai viết release notes?</p>'],
  [-2, '11:10', ANH, '<p>Chị viết release notes, gửi mọi người duyệt trước {+1}.</p>'],
  [-2, '13:00', HUY, '<p>Build 2.0.0 (52) đã lên TestFlight.</p>'],
  [-2, '15:00', HA, '<p>Bắt đầu regression vòng 2 trên build 52.</p>'],
  [-2, '17:30', BAO, '<p>Tối nay team đi ăn lẩu mừng fix xong bug chặn không? <emoji id="stew" alt="🍲" title="Stew"></emoji></p>'],
  [-2, '17:35', LAN, '<p>Đi đi!</p>'],
  [-2, '17:36', HUY, '<p>Em tham gia.</p>'],

  [-1, '09:00', HA, '<p>Regression vòng 2: 148/150 pass, 2 fail mức P3 không chặn release.</p>'],
  [-1, '09:05', ANH, '<p>Ok. 2 bug P3 dời sang v2.0.1.</p>'],
  [-1, '09:30', BAO, '<p>Mình chuẩn bị xong kịch bản rollback cho backend.</p>'],
  [-1, '10:00', ANH, '<p><b>Kế hoạch ngày release {+9}:</b></p><ol><li>08:00 Bảo deploy backend</li><li>09:00 Huy submit app lên store</li><li>10:00 Hà smoke test production</li><li>11:00 Lan đăng bài truyền thông</li></ol>'],
  [-1, '10:10', HUY, '<p>Em hỏi: submit lên store thì ai duyệt trên tài khoản Apple Developer ạ?</p>'],
  [-1, '10:20', ANH, '<p>Chị là admin tài khoản, em gửi chị trước 1 ngày để chị duyệt nhé.</p>'],
  [-1, '14:00', LAN, '<p>Bài truyền thông bản nháp đây ạ, mọi người góp ý trước {+5} nhé.</p>'],
  [-1, '15:00', BAO, '<p>Mình góp ý trong doc rồi.</p>'],
  [-1, '17:00', ANH, '<p>Cảm ơn mọi người, tiến độ đang rất tốt <emoji id="clap" alt="👏" title="Clap"></emoji></p>'],

  [0, '08:30', HA, '<p>Chào buổi sáng! Hôm nay mình chạy lại smoke test trên build 53.</p>'],
  [0, '08:35', HUY, '<p>Build 53 chỉ đổi text release notes thôi chị.</p>'],
  [0, '08:45', BAO, '<p>Nhắc mọi người: <b>code freeze</b> vào {+2}, sau đó chỉ merge bug P1 nhé.</p>'],
  [0, '09:00', ANH, '<p>Release notes bản nháp đã gửi qua mail, mọi người duyệt giúp chị trước {+1}.</p>'],
  [0, '09:05', LAN, '<p>Em duyệt rồi, ok ạ.</p>'],
  [0, '09:10', HA, '<p>Smoke test build 53 pass <emoji id="check" alt="✅" title="Check"></emoji></p>'],
  [0, '09:15', ANH, '<p>Tuyệt vời. Hẹn mọi người ở buổi họp go/no-go ngày {+8} lúc 15h.</p>'],
  [0, '09:20', HUY, '<p>Dạ ok chị!</p>'],
]

/**
 * Older history, same format, every day ≤ -HISTORY_END. Days without a line here
 * get routine messages from ROUTINE (when they are working days).
 */
const HISTORY: readonly ScriptLine[] = [
  [-120, '09:00', ANH, '<p>Chào cả nhà, bản <b>v1.9</b> đã lên store tuần trước. Tuần này mình tập trung thu thập phản hồi người dùng nhé.</p>'],
  [-120, '09:12', HA, '<p>Mình tổng hợp được 37 phản hồi trên store, nhiều nhất là app chậm khi mở danh sách lịch hẹn.</p>'],
  [-113, '14:00', ANH, '<p>Khách hàng muốn bản lớn tiếp theo có <b>thanh toán trong app</b> và <b>dark mode</b>. Chị sẽ gom yêu cầu thành tài liệu v2.0.</p>'],
  [-106, '10:00', BAO, '<p>Mình đo được API danh sách lịch hẹn mất 1,8 giây ở p95, v2.0 cần tối ưu phần này.</p>'],
  [-99, '16:00', ANH, '<p>Tài liệu yêu cầu v2.0 bản nháp đã lên wiki, mọi người đọc trước buổi kickoff ngày {-96} nhé.</p>'],

  [-96, '09:00', ANH, '<p><b>Kickoff v2.0</b>: mục tiêu là thanh toán trong app, dark mode và đặt lịch nhanh hơn.</p>'],
  [-96, '09:20', BAO, '<p>Backend đề xuất tách dịch vụ thanh toán riêng, ước lượng 3 tuần.</p>'],
  [-96, '09:25', HUY, '<p>Mobile ước lượng 4 tuần cho thanh toán + dark mode.</p>'],
  [-96, '09:30', LAN, '<p>Design cần khoảng 2 tuần cho toàn bộ màn hình mới.</p>'],
  [-96, '09:40', HA, '<p>QA đề xuất viết test plan song song với thiết kế.</p>'],
  [-89, '10:00', ANH, '<p><b>Quyết định:</b> v2.0 chỉ hỗ trợ iOS 16 và Android 10 trở lên. Chị đã thống nhất với khách hàng.</p>'],
  [-89, '10:05', HUY, '<p>Tốt quá, bỏ được nhiều code cũ.</p>'],
  [-82, '15:00', BAO, '<p>Mình so sánh 2 cổng thanh toán: <b>PayNow</b> phí 1,5%, hỗ trợ ví điện tử; <b>VietPay</b> phí 1,2% nhưng tài liệu API kém hơn.</p>'],
  [-82, '15:20', ANH, '<p>Chưa chốt cổng thanh toán vội, đợi bên tài chính phản hồi đã.</p>'],
  [-78, '10:00', HUY, '<p>Em đề xuất chưa làm giao diện tablet ở v2.0 để kịp tiến độ.</p>'],
  [-78, '10:20', ANH, '<p>Đồng ý, tablet chuyển sang backlog v2.1.</p>'],
  [-75, '09:00', ANH, '<p>Roadmap v2.0:</p><ul><li>Thiết kế &amp; test plan: {-66} → {-45}</li><li>Phát triển: {-45} → {-14}</li><li>Regression &amp; release: sau đó</li></ul>'],
  [-68, '17:00', ANH, '<p>Tổng kết giai đoạn lập kế hoạch: scope đã chốt, tuần tới bắt đầu thiết kế. Cảm ơn mọi người!</p>'],

  [-64, '09:00', LAN, '<p>Bắt đầu thiết kế: tuần này em làm luồng đặt lịch mới và màn hình thanh toán.</p>'],
  [-62, '14:00', HA, '<p>Bản nháp test plan v2.0 xong 60%, còn phần thanh toán.</p>'],
  [-60, '10:00', LAN, '<p>Đã up 2 phương án luồng đặt lịch lên Figma (A: 3 bước, B: 2 bước), mọi người xem trước buổi review ngày {-57} nhé.</p>'],
  [-57, '09:00', ANH, '<p><b>Họp review thiết kế</b> sáng nay: so sánh phương án A và B của luồng đặt lịch.</p>'],
  [-57, '09:30', HUY, '<p>Phương án B ít bước hơn, mobile làm kịp trong sprint đầu.</p>'],
  [-57, '09:35', HA, '<p>B cũng ít case test hơn, mình ủng hộ B.</p>'],
  [-57, '10:00', ANH, '<p><b>Quyết định:</b> chọn <b>phương án B</b> (đặt lịch 2 bước) và cổng thanh toán <b>PayNow</b> vì tài liệu API tốt và hỗ trợ ví điện tử.</p>'],
  [-57, '10:05', BAO, '<p>Ok, mình bắt đầu tích hợp sandbox PayNow ngay.</p>'],
  [-56, '09:00', ANH, '<p><b>Việc cần làm sau buổi review:</b></p><ul><li>Lan: hoàn thiện thiết kế phương án B – hạn {-53}</li><li>Bảo: tích hợp sandbox PayNow – hạn {-54}</li><li>Hà: hoàn thành test plan v2.0 – hạn {-53}</li><li>Huy: dựng khung màn hình đặt lịch mới – hạn {-53}</li></ul>'],
  [-56, '09:10', LAN, '<p>Em nhận ạ.</p>'],
  [-55, '11:00', BAO, '<p>Sandbox PayNow đã kết nối, giao dịch test đầu tiên thành công.</p>'],
  [-55, '15:00', HA, '<p>Cho mình hỏi: thanh toán thất bại thì app hiển thị gì? Mình cần để viết test case.</p>'],
  [-55, '15:20', LAN, '<p>Có màn hình lỗi riêng, em bổ sung vào Figma trong hôm nay.</p>'],
  [-54, '10:00', HUY, '<p>Khung màn hình đặt lịch 2 bước đã chạy trên máy thật.</p>'],
  [-53, '16:30', HA, '<p>Test plan v2.0 hoàn thành: 150 test case, trong đó 40 case thanh toán. Link trên wiki.</p>'],
  [-53, '16:40', ANH, '<p>Cảm ơn Hà, đúng hạn luôn.</p>'],
  [-53, '17:00', LAN, '<p>Thiết kế phương án B đã hoàn thiện và bàn giao cho Huy; dark mode còn chỉnh token màu.</p>'],
  [-47, '09:00', HA, '<p>Đã thiết lập test tự động trên CI cho các luồng chính.</p>'],
  [-43, '14:00', BAO, '<p>Dịch vụ thanh toán đã có API tạo giao dịch và webhook xác nhận.</p>'],
  [-40, '10:00', ANH, '<p>Sprint review: design xong phần chính, backend thanh toán 50%, mobile 30%.</p>'],

  [-33, '09:00', ANH, '<p>Bắt đầu giai đoạn phát triển chính. Mốc code freeze vẫn theo roadmap.</p>'],
  [-30, '20:10', BAO, '<p>Cảnh báo: production v1.9 lỗi đăng nhập từ 19h50, mình đang kiểm tra.</p>'],
  [-30, '20:25', BAO, '<p>Nguyên nhân: chứng chỉ SSL của API xác thực hết hạn. Đã gia hạn, đăng nhập hoạt động lại.</p>'],
  [-30, '20:31', ANH, '<p>Cảm ơn Bảo đã xử lý cuối tuần. Mai mình họp rút kinh nghiệm nhé.</p>'],
  [-30, '20:40', HA, '<p>Mình đã test lại đăng nhập trên iOS và Android, ok rồi.</p>'],
  [-29, '10:00', ANH, '<p><b>Rút kinh nghiệm sự cố {-30}:</b> Bảo thêm cảnh báo trước 30 ngày khi chứng chỉ sắp hết hạn – hạn {-26}.</p>'],
  [-26, '15:00', BAO, '<p>Đã thêm cảnh báo hết hạn chứng chỉ vào hệ thống giám sát.</p>'],
  [-22, '10:00', HUY, '<p>Dark mode xong khoảng 70%, màn hình thanh toán đang làm.</p>'],
  [-19, '14:00', BAO, '<p>API đặt lịch mới chạy trên staging, p95 còn 450ms (v1.9 là 1,8 giây).</p>'],
  [-15, '16:00', ANH, '<p>Tuần sau bắt đầu nước rút cho v2.0, mọi người chuẩn bị nhé.</p>'],
]

type RoutineLine = readonly [who: number, html: string]

/**
 * Routine messages per phase, keyed by the phase's first day and dealt like a
 * shuffled deck so lines rarely repeat. "{pr}", "{bug}", "{patch}", "{build}"
 * and "{pass}" become increasing numbers, "{fix}" the oldest reported bug not
 * fixed yet (the line is skipped when there is none), "{issue}", "{feedback}"
 * and "{feature}" the next item of their list.
 */
const ROUTINE: ReadonlyArray<readonly [fromDay: number, lines: readonly RoutineLine[]]> = [
  [-HISTORY_DAYS, [
    [HA, '<p>Phản hồi mới từ người dùng: {feedback}.</p>'],
    [BAO, '<p>Đã sửa bug #{fix} trên v1.9, PR #{pr}.</p>'],
    [HUY, '<p>Bản vá v1.9.{patch} đã gửi lên store.</p>'],
    [HA, '<p>Bug #{bug}: {issue}.</p>'],
    [ANH, '<p>Mọi người nhớ cập nhật board hằng ngày nhé.</p>'],
    [LAN, '<p>Em đang khảo sát giao diện các app đặt lịch khác để lấy ý tưởng cho bản sau.</p>'],
    [BAO, '<p>Log server tuần này ổn định, không có lỗi 5xx đáng kể.</p>'],
    [HUY, '<p>Đã nâng cấp thư viện bản đồ, app khởi động nhanh hơn một chút.</p>'],
    [ANH, '<p>Điểm đánh giá v1.9 trên store đã lên 4,5.</p>'],
    [HA, '<p>Đã verify các bản sửa trong tuần, tất cả ok.</p>'],
    [LAN, '<p>Em cập nhật lại bộ icon cho đồng bộ với nhận diện thương hiệu mới.</p>'],
    [HA, '<p>Phản hồi mới từ người dùng: {feedback}.</p>'],
  ]],
  [-97, [
    [ANH, '<p>Chị đang cập nhật tài liệu yêu cầu v2.0 theo góp ý của mọi người.</p>'],
    [BAO, '<p>Mình viết thiết kế kiến trúc dịch vụ thanh toán, mọi người góp ý trên wiki nhé.</p>'],
    [HUY, '<p>Mobile đang thử thư viện dark mode, khá ổn.</p>'],
    [LAN, '<p>Em đã có moodboard cho giao diện v2.0 trong Figma.</p>'],
    [HA, '<p>Mình đang liệt kê rủi ro chất lượng cho v2.0: thanh toán, đồng bộ offline, hiệu năng.</p>'],
    [BAO, '<p>Đã tạo ticket cho các hạng mục backend v2.0 trên board.</p>'],
    [HA, '<p>Đã chốt danh sách thiết bị test: 6 máy Android, 4 iPhone.</p>'],
    [HUY, '<p>Bản vá v1.9.{patch} đã gửi lên store (chỉ sửa lỗi nhỏ).</p>'],
    [BAO, '<p>Đã sửa bug #{fix} trên v1.9, PR #{pr}.</p>'],
    [HA, '<p>Bug #{bug}: {issue}.</p>'],
    [ANH, '<p>Đã gửi khách hàng bản ước lượng v2.0, đang chờ phản hồi.</p>'],
    [LAN, '<p>Em đang làm style guide mới: màu, font chữ, khoảng cách.</p>'],
  ]],
  [-66, [
    [LAN, '<p>Cập nhật Figma: thêm trạng thái loading và empty state cho màn hình lịch hẹn.</p>'],
    [HA, '<p>Đang viết test case cho luồng đặt lịch.</p>'],
    [BAO, '<p>Đặc tả API thanh toán (OpenAPI) đã cập nhật, mọi người review giúp.</p>'],
    [HUY, '<p>Mobile đã dựng design system theo token màu mới.</p>'],
    [ANH, '<p>Nhắc: mọi góp ý thiết kế gửi trước cuối tuần nhé.</p>'],
    [HA, '<p>Bug #{bug}: {issue}.</p>'],
    [BAO, '<p>Migration cho bảng giao dịch đã chạy thử trên staging.</p>'],
    [HUY, '<p>PoC thanh toán ví điện tử trên mobile, PR #{pr}.</p>'],
    [HA, '<p>Đã thêm test case cho kịch bản mất mạng khi thanh toán.</p>'],
    [LAN, '<p>Em đã sửa thiết kế theo góp ý của Hà, mọi người xem lại giúp em.</p>'],
    [BAO, '<p>Đã sửa bug #{fix}, PR #{pr}.</p>'],
    [ANH, '<p>Chị đã gửi khách hàng xem bản thiết kế, họ khá hài lòng.</p>'],
  ]],
  [-35, [
    [BAO, '<p>Merged PR #{pr}: {feature}.</p>'],
    [HUY, '<p>PR #{pr} cho mobile đã sẵn sàng, nhờ Bảo review.</p>'],
    [HA, '<p>Bug #{bug}: {issue}.</p>'],
    [HUY, '<p>Đã sửa bug #{fix}, PR #{pr}.</p>'],
    [ANH, '<p>Mọi người cập nhật tiến độ trên board giúp chị.</p>'],
    [LAN, '<p>Đã xuất asset bản mới cho mobile.</p>'],
    [BAO, '<p>Staging đã cập nhật backend mới nhất.</p>'],
    [HA, '<p>Test tự động đêm qua: {pass}% pass.</p>'],
    [HUY, '<p>Build nội bộ 2.0.0 ({build}) đã gửi team test.</p>'],
    [ANH, '<p>Khách hàng hỏi tiến độ, chị đã báo đang đúng kế hoạch.</p>'],
    [BAO, '<p>Merged PR #{pr}: {feature}.</p>'],
    [BAO, '<p>Đã viết thêm unit test cho dịch vụ thanh toán, coverage 80%.</p>'],
  ]],
]

const LISTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['issue', [
    'thông báo nhắc lịch hiển thị sai giờ khi đổi múi giờ',
    'lịch hẹn bị trùng sau khi đồng bộ',
    'ảnh đại diện không tải được khi mạng yếu',
    'sai định dạng ngày ở màn hình lịch sử',
    'nút hủy lịch không phản hồi trên Android 11',
    'app văng khi xoay màn hình ở trang chi tiết',
    'nút xác nhận thanh toán quá nhỏ trên màn hình nhỏ',
    'sai số tiền hiển thị khi áp mã giảm giá',
    'thanh toán bị gửi hai lần khi bấm nhanh',
    'màn hình đặt lịch không cuộn được trên iPhone SE',
  ]],
  ['feedback', [
    'muốn được nhắc lịch hẹn sớm hơn',
    'muốn xem lịch theo tuần',
    'muốn thanh toán ngay trong app',
    'muốn có giao diện tối',
    'muốn đặt lịch lặp lại hằng tuần',
  ]],
  ['feature', ['webhook xác nhận thanh toán', 'API hoàn tiền', 'tối ưu truy vấn lịch hẹn', 'hàng đợi gửi thông báo', 'lưu lịch sử giao dịch']],
])

/** The whole conversation for `now`, oldest first. Fresh objects on every call. */
export function demoMessages(now: number): GraphChatMessage[] {
  const localNow = now + ZONE_OFFSET_MS
  let anchorDay = Math.floor(localNow / DAY_MS) * DAY_MS - ZONE_OFFSET_MS
  // Keep every message in the past: early in the morning the script ends yesterday.
  if (localNow - (anchorDay + ZONE_OFFSET_MS) < ANCHOR_CUTOFF_MINUTES * 60_000) anchorDay -= DAY_MS
  // Separate generators so the recent script keeps its timestamps whatever the history holds.
  const random = mulberry32(0x6d656f)
  const recent = SCRIPT.map(([day, clock, who, html, special], index) => demoMessage(
    `demo-${String(index + 1).padStart(3, '0')}`, timeAt(anchorDay, day, clockMinutes(clock), Math.floor(random() * 50)), who, withDates(html, anchorDay), special,
  ))
  return [...history(anchorDay), ...recent]
}

/** Scripted history plus 1–3 routine messages on most other working days. */
function history(anchorDay: number): GraphChatMessage[] {
  const random = mulberry32(0x686973)
  const counters = new Map([['pr', 150], ['bug', 160], ['patch', 1], ['build', 20], ['pass', 88]])
  const dealt = new Map<string, number>()
  let fixed = 160
  const fill = (html: string): string | undefined => {
    if (html.includes('{fix}')) {
      if (fixed >= (counters.get('bug') ?? 0)) return undefined
      html = html.replace('{fix}', String(++fixed))
    }
    return html.replace(/\{([a-z]+)\}/g, (match, name: string) => {
      const counter = counters.get(name)
      if (counter !== undefined) {
        counters.set(name, counter + 1)
        return String(counter + 1)
      }
      const index = dealt.get(name) ?? 0
      dealt.set(name, index + 1)
      const list = LISTS.get(name) ?? []
      return list[index % list.length] ?? match
    })
  }
  const decks = new Map<readonly RoutineLine[], number[]>()
  /** Next line of the phase's shuffled deck that can be filled in. */
  const deal = (pool: readonly RoutineLine[]): { readonly who: number; readonly html: string } | undefined => {
    for (let tries = 0; tries < pool.length; tries++) {
      let deck = decks.get(pool)
      if (deck === undefined || deck.length === 0) {
        deck = pool.map((_, index) => index)
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1))
          ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
        }
        decks.set(pool, deck)
      }
      const [who, html] = pool[deck.pop() ?? 0] ?? []
      const filled = html === undefined ? undefined : fill(html)
      if (who !== undefined && filled !== undefined) return { who, html: filled }
    }
    return undefined
  }

  const lines: Array<{ readonly time: number; readonly who: number; readonly html: string }> = []
  for (let day = -HISTORY_DAYS; day <= -HISTORY_END; day++) {
    const at = (minutes: number): number => timeAt(anchorDay, day, minutes, Math.floor(random() * 50))
    const scripted = HISTORY.filter(line => line[0] === day)
    if (scripted.length > 0) {
      for (const [, clock, who, html] of scripted) lines.push({ time: at(clockMinutes(clock)), who, html: withDates(html, anchorDay) })
      continue
    }
    const weekday = new Date(timeAt(anchorDay, day, 0, 0) + ZONE_OFFSET_MS).getUTCDay()
    if (weekday === 0 || weekday === 6 || random() >= BUSY_DAY_RATE) continue
    const pool = ROUTINE.findLast(([fromDay]) => fromDay <= day)?.[1] ?? []
    // Office hours 08:30–17:30, in order within the day.
    const minutes = Array.from({ length: 1 + Math.floor(random() * 3) }, () => 510 + Math.floor(random() * 540)).sort((a, b) => a - b)
    for (const minute of minutes) {
      const line = deal(pool)
      if (line !== undefined) lines.push({ time: at(minute), ...line })
    }
  }
  return lines.map(({ time, who, html }, index) => demoMessage(`demo-h${String(index + 1).padStart(3, '0')}`, time, who, html))
}

function demoMessage(id: string, time: number, who: number, body: string, special?: Special): GraphChatMessage {
  const createdDateTime = new Date(time).toISOString()
  const person = PEOPLE[who] ?? PEOPLE[0]!
  const base = {
    id,
    replyToId: null,
    createdDateTime,
    lastModifiedDateTime: createdDateTime,
    subject: null,
    attachments: [],
    mentions: [],
  } satisfies Partial<GraphChatMessage>

  if (special === 'system') {
    return { ...base, messageType: 'systemEventMessage', deletedDateTime: null, from: null, body: { contentType: 'html', content: body } }
  }
  const message: GraphChatMessage = {
    ...base,
    messageType: 'message',
    deletedDateTime: special === 'deleted' ? new Date(time + 60_000).toISOString() : null,
    from: { user: { id: person.id, displayName: person.name }, application: null },
    body: { contentType: 'html', content: body },
  }
  if (special === 'mention-huy') {
    return { ...message, mentions: [{ id: 0, mentionText: PEOPLE[HUY]!.name }] }
  }
  if (special === 'file') {
    return {
      ...message,
      attachments: [{
        id: 'demo-att-regression',
        contentType: 'reference',
        name: 'KeHoach_Regression_v2.0.xlsx',
        contentUrl: 'https://contoso.sharepoint.com/sites/meobeo/Shared%20Documents/KeHoach_Regression_v2.0.xlsx',
      }],
    }
  }
  return message
}

function timeAt(anchorDay: number, day: number, minutes: number, seconds: number): number {
  return anchorDay + day * DAY_MS + (minutes * 60 + seconds) * 1000
}

function clockMinutes(clock: string): number {
  const [hours = 0, minutes = 0] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

/** "{+9}" → the date (dd/MM) nine days after the anchor day. */
function withDates(html: string, anchorDay: number): string {
  return html.replace(/\{([+-]\d+)\}/g, (_, offset: string) => {
    const local = new Date(anchorDay + Number(offset) * DAY_MS + ZONE_OFFSET_MS)
    return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}`
  })
}

/** Small seeded PRNG: demo timestamps get natural-looking seconds without Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
