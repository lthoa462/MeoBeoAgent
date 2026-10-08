import type { Metadata } from 'next'
import styles from './privacy.module.css'

/**
 * Privacy statement and terms of use, reachable without signing in: the Teams
 * manifest links here (privacyUrl / termsOfUseUrl). Static, no client code.
 */
export const metadata: Metadata = {
  title: 'Quyền riêng tư và điều khoản – MeoBeo',
  description: 'MeoBeo đọc tin nhắn Teams khi được yêu cầu và không lưu lại nội dung.',
}

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <h1>MeoBeo – quyền riêng tư và điều khoản</h1>
      <p>
        MeoBeo tóm tắt group chat và kênh Microsoft Teams: ý chính, quyết định, việc cần làm và câu trả lời cho
        câu hỏi của bạn. Trang này nói MeoBeo làm gì với tin nhắn của bạn.
      </p>

      <section id="quyen-rieng-tu" aria-labelledby="quyen-rieng-tu-title">
        <h2 id="quyen-rieng-tu-title">Quyền riêng tư</h2>
        <ul>
          <li>
            <strong>Chỉ đọc khi được yêu cầu.</strong> Trên web, MeoBeo đọc cuộc trò chuyện bạn chọn bằng quyền của
            chính bạn. Trong Teams, MeoBeo chỉ đọc khi có người @nhắc tên nó, và chỉ trong khoảng thời gian được hỏi.
            Tin nhắn không nhắc tới MeoBeo bị bỏ qua.
          </li>
          <li>
            <strong>Không lưu tin nhắn.</strong> Tin nhắn chỉ nằm trong bộ nhớ của máy chủ trong lúc trả lời, và tối
            đa vài phút sau đó (mặc định 10 phút) để trả lời câu hỏi tiếp theo. Không có cơ sở dữ liệu, không ghi ra
            ổ đĩa, không ghi nội dung tin nhắn hay token vào log.
          </li>
          <li>
            <strong>Trình duyệt không lưu hội thoại.</strong> Nội dung chat chỉ ở trong trang đang mở; tải lại trang là
            mất. Phiên đăng nhập Microsoft được giữ trong tab và hết khi đóng tab.
          </li>
          <li>
            <strong>Gửi tới nhà cung cấp mô hình AI.</strong> Để tóm tắt, tin nhắn trong khoảng thời gian được hỏi
            được gửi tới nhà cung cấp mô hình AI (OpenAI hoặc Google Gemini) do quản trị viên cấu hình. Chính sách
            dữ liệu của nhà cung cấp đó vẫn áp dụng.
          </li>
          <li>
            <strong>AI không chọn được đọc ở đâu.</strong> Cuộc trò chuyện cần đọc và quyền truy cập do máy chủ gắn
            vào từng yêu cầu; mô hình AI chỉ chọn khoảng thời gian và câu hỏi.
          </li>
        </ul>
      </section>

      <section id="dieu-khoan" aria-labelledby="dieu-khoan-title">
        <h2 id="dieu-khoan-title">Điều khoản sử dụng</h2>
        <ul>
          <li>
            Bản tóm tắt do AI viết nên có thể sai hoặc thiếu. Hãy đối chiếu với tin nhắn gốc qua số thứ tự (#n) trước
            khi dựa vào đó để quyết định.
          </li>
          <li>Chỉ dùng MeoBeo cho những cuộc trò chuyện bạn được phép đọc, theo quy định của tổ chức bạn.</li>
          <li>
            Tổ chức triển khai MeoBeo chịu trách nhiệm về cấu hình, quyền cấp cho ứng dụng và lựa chọn nhà cung cấp
            mô hình AI. Thắc mắc về dữ liệu, hãy liên hệ quản trị viên của tổ chức.
          </li>
          <li>MeoBeo là phần mềm mã nguồn mở (giấy phép MIT), cung cấp nguyên trạng, không kèm bảo đảm.</li>
        </ul>
      </section>

      <p>
        <a href="/">Mở MeoBeo</a>
      </p>
    </main>
  )
}
