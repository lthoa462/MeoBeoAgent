// Mục lục SGK Toán 10 – bộ "Kết nối tri thức với cuộc sống" (CT GDPT 2018).
// Đây là dữ liệu tra cứu để agent bám sát đúng tên chương/bài.
// Nếu trường bạn dùng bộ sách khác (Cánh Diều, Chân trời sáng tạo), sửa file này.

export type Lesson = { number: number; title: string }
export type Chapter = { number: string; title: string; volume: 1 | 2; lessons: Lesson[] }

export const TEXTBOOK = 'Toán 10 – Kết nối tri thức với cuộc sống'

export const CHAPTERS: Chapter[] = [
  { number: 'I', volume: 1, title: 'Mệnh đề và tập hợp', lessons: [
    { number: 1, title: 'Mệnh đề' },
    { number: 2, title: 'Tập hợp và các phép toán trên tập hợp' },
  ] },
  { number: 'II', volume: 1, title: 'Bất phương trình và hệ bất phương trình bậc nhất hai ẩn', lessons: [
    { number: 3, title: 'Bất phương trình bậc nhất hai ẩn' },
    { number: 4, title: 'Hệ bất phương trình bậc nhất hai ẩn' },
  ] },
  { number: 'III', volume: 1, title: 'Hệ thức lượng trong tam giác', lessons: [
    { number: 5, title: 'Giá trị lượng giác của một góc từ 0° đến 180°' },
    { number: 6, title: 'Hệ thức lượng trong tam giác' },
  ] },
  { number: 'IV', volume: 1, title: 'Vectơ', lessons: [
    { number: 7, title: 'Các khái niệm mở đầu' },
    { number: 8, title: 'Tổng và hiệu của hai vectơ' },
    { number: 9, title: 'Tích của một vectơ với một số' },
    { number: 10, title: 'Vectơ trong mặt phẳng tọa độ' },
    { number: 11, title: 'Tích vô hướng của hai vectơ' },
  ] },
  { number: 'V', volume: 1, title: 'Các số đặc trưng của mẫu số liệu không ghép nhóm', lessons: [
    { number: 12, title: 'Số gần đúng và sai số' },
    { number: 13, title: 'Các số đặc trưng đo xu thế trung tâm' },
    { number: 14, title: 'Các số đặc trưng đo độ phân tán' },
  ] },
  { number: 'VI', volume: 2, title: 'Hàm số, đồ thị và ứng dụng', lessons: [
    { number: 15, title: 'Hàm số' },
    { number: 16, title: 'Hàm số bậc hai' },
    { number: 17, title: 'Dấu của tam thức bậc hai' },
    { number: 18, title: 'Phương trình quy về phương trình bậc hai' },
  ] },
  { number: 'VII', volume: 2, title: 'Phương pháp tọa độ trong mặt phẳng', lessons: [
    { number: 19, title: 'Phương trình đường thẳng' },
    { number: 20, title: 'Vị trí tương đối giữa hai đường thẳng. Góc và khoảng cách' },
    { number: 21, title: 'Đường tròn trong mặt phẳng tọa độ' },
    { number: 22, title: 'Ba đường conic' },
  ] },
  { number: 'VIII', volume: 2, title: 'Đại số tổ hợp', lessons: [
    { number: 23, title: 'Quy tắc đếm' },
    { number: 24, title: 'Hoán vị, chỉnh hợp và tổ hợp' },
    { number: 25, title: 'Nhị thức Newton' },
  ] },
  { number: 'IX', volume: 2, title: 'Tính xác suất theo định nghĩa cổ điển', lessons: [
    { number: 26, title: 'Biến cố và định nghĩa cổ điển của xác suất' },
    { number: 27, title: 'Thực hành tính xác suất theo định nghĩa cổ điển' },
  ] },
]
