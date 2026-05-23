import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "대전 안심맵",
  description: "스마트시티 공공데이터로 그리는 야간 보행자 안전 지도",
  manifest: "/manifest.json",
};

const KAKAO_KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        {/* Kakao Maps SDK · autoload=false → 수동 load 로 onload 콜백 사용 */}
        <Script
          src={`//dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&libraries=services,clusterer&autoload=false`}
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
