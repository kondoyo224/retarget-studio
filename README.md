# Retarget Studio

모캡 애니메이션을 불러와 리타게팅·키 편집·접촉 보정·레이어 합성·검수·출력을 진행하는 FBX 중심 웹 도구입니다. [웹 빌드](https://kondoyo224.github.io/retarget-studio/). FBX 3D 읽기에는 Three.js를 CDN에서 불러오므로 웹 연결이 필요합니다.

## 사용자 흐름

1. **가져오기** — FBX를 읽어 모델·본 계층·원하는 애니메이션 클립을 3D 뷰포트에서 확인합니다. FBX 시간축 샘플링은 현재 30 fps 기준입니다. BVH도 프레임 데이터로 읽고 재생합니다.
2. **리타게팅** — 소스 의미 슬롯과 대상 Character Definition을 연결해 FBX→FBX 또는 BVH→BVH로 변환합니다. FBX 결과는 FBX 또는 GLB로 출력합니다.
3. **키 편집** — 선택 본의 회전 키를 추가·수정하고, 보간·중복 키 정리·스무딩을 적용합니다. Motion Layer와 Story 편집 결과는 미리보기와 출력에 반영됩니다.
4. **분류** — 캐릭터 모델을 모델 그룹으로 묶고, 그룹에 연결된 동작을 종·장비·행동·세부 동작·출처로 검색합니다.
5. **검수와 출력** — 필수 본, 선택 본, 체인 설정, 발 접촉, 분류 정보를 확인하고 포맷·프레임 범위·FPS·축·단위를 설정합니다.

## 체인 본 수가 다를 때

리타게팅은 `Spine`, `Neck`, `Tail`처럼 의미가 같은 본 체인 단위로 처리합니다. 예를 들어 소스 Spine이 3개, 대상 Spine이 5개면 본 하나씩 단순 복사하지 않고 체인 전체 회전을 대상 체인에 재분배합니다. 반대로 소스가 더 길면 여러 소스 회전을 누적해 더 짧은 대상 체인에 합칩니다. 화면 예제는 Neck 1개를 Neck 2개로 재분배합니다.

`retarget-core.js`의 체인 재분배 수학을 BVH 변환기와 FBX 변환기에서 사용합니다.

- 소스 각 분절의 회전 변화량을 공통 체인 좌표계로 바꾸고 누적 방향 곡선을 만듭니다.
- 기본은 rest-pose 분절 길이를 정규화한 길이 가중 방식이며, 균등 또는 사용자 가중치도 선택할 수 있습니다.
- 대상 분절 경계에서 누적 회전을 구면 보간으로 샘플링하고, 이웃 샘플의 상대 회전을 대상 분절 회전으로 복원합니다.
- 체인의 시작 자세와 전체 끝 회전은 유지됩니다. 같은 수의 본과 같은 분절 위치라면 직접 전달과 동일하게 동작합니다.

FBX 어댑터는 파일에서 읽은 rest pose와 world-space 본 방향을 사용해 소스 회전을 공통 체인 좌표계로 바꾸고, 결과를 대상 rest pose로 되돌립니다. 양쪽에 Neck 슬롯이 있으면 Spine과 Neck을 따로 분배하고, Neck 연결이 없으면 Spine부터 Head까지 한 체인으로 처리합니다. 화면의 Spine/Neck 본 이름과 체인 수는 실제 매핑에 따라 갱신됩니다.

## 모션 라이브러리 데이터 구상

모델과 모션을 자유 텍스트 하나로만 저장하지 않고 서로 연결된 필드와 확장 가능한 태그로 분류합니다.

- **Model Group**: 모델 ID, 표시 이름, 모델 파일, 스켈레톤 프로필, 종/리그 유형
- **Motion Asset**: 모션 ID, 연결 Model Group, 파일, FPS, 프레임 범위, 루프 여부, Root motion 여부
- **분류 태그**: 출처(모캡/게임 추출/키 애니메이션), 무기(대검/활/비무장), 행동(이동/일상/공격/죽음/비행), 세부 동작(가로 베기/대각선 베기/인사/달리기/이륙), 좌우·방향, 품질 검수 결과
- **게임 추출 추적 정보**: 게임과 빌드, 원본 에셋 ID, 연결 모델 ID, 추출 도구·리포지터리 버전, 원본 파일 해시

사용자가 지정한 [REA 저장소](https://github.com/morluto/rea)는 앱·바이너리·런타임을 조사하는 역공학 에이전트 도구입니다. Godot PCK 등 일부 패키지 분석·추출 워크플로는 있지만, 게임 애니메이션을 공통 포맷으로 바로 변환해 주는 범용 모션 추출기는 아닙니다. 따라서 흐름은 **REA로 포맷과 참조 관계 조사 → 게임별 추출 어댑터 구현 → 공통 `Model Group`/`Motion Asset`으로 변환 → 리타게팅·라벨링**으로 나눕니다. 추출 어댑터는 게임별 규칙과 편집기를 분리하는 경계가 됩니다.

이 앱은 이 연결을 위한 `rea-motion-manifest.schema.json`을 정의하고, 라이브러리 화면에서 해당 형식의 JSON을 읽고 라벨을 편집합니다. [`rea-motion-manifest.example.json`](rea-motion-manifest.example.json)은 분류 화면을 확인하기 위한 가상 예시이며 실제 게임 추출 데이터가 아닙니다. 형식 버전 1에는 게임/빌드, 추출기와 리포지터리 버전, 모델과 종, 모션 파일, FPS/프레임, 무기, 행동/세부 동작, 방향, 루프/Root motion, 품질과 출처 추적 정보를 담습니다. 분류 후 같은 manifest 형식으로 다시 내보낼 수 있습니다.

## 현재 구현 범위

FBX는 모델·스켈레톤·클립을 읽어 3D 미리보기, Orbit/Front/Side 전환과 프레임 재생을 지원합니다. 대상 그림에는 MotionBuilder 방식의 필수 15개 휴머노이드 슬롯을 배치하고 계층을 검증합니다. Neck, Spine1–Spine9, 발가락 슬롯도 연결할 수 있습니다. 소스 FBX에서 클립을 고르고 의미 슬롯을 수정한 뒤 Character Definition을 완료하면 실제 FBX→FBX 변환을 실행합니다. Hips와 팔다리는 의미 슬롯끼리 변환하고 Spine/Neck은 rest pose 기준으로 재분배합니다. 길이 가중 또는 균등 분배, 자동/수동 스케일, 좌우 미러, Root motion 적용·In-place·별도 추출을 지원합니다. 연결된 체인 수와 본 이름도 매핑을 따라 표시합니다.

FBX 출력은 스켈레톤·메시·베이크된 본 애니메이션을 담은 Binary FBX로 저장합니다. 대상 프리셋, up-axis, 단위, 프레임 범위와 FPS를 지정할 수 있습니다. GLB도 대체 출력 형식으로 지원합니다. BVH→BVH 리타게팅·BVH 출력도 유지됩니다. 선택 본 회전 키 편집은 Base 또는 선택 Motion Layer에 기록됩니다. Override/Additive 레이어는 전신·상체·하체·팔 마스크와 가중치·Solo·Mute를 적용하며, 빈 보정 레이어에서 새 키를 만들 수 있습니다. Story는 모션을 프레임 순서대로 이어 붙여 미리보기와 FBX/GLB에 베이크합니다. 발 접촉은 바닥 높이와 프레임 간 발 속도로 구간을 찾고, 2-bone IK로 발을 고정합니다. Aux Effector는 손·발의 현재 월드 위치를 캡처하고 구간·가중치를 지정해 같은 IK 솔버로 베이크합니다. IK Translation/Rotation Blend도 솔버 강도에 반영됩니다. 모델 그룹에 FBX 파일을 연결하면 본 수와 파일 정보를 카탈로그에 저장하며, 종·무기·행동·세부 동작 라벨을 manifest JSON으로 가져오거나 내보낼 수 있습니다.

현재 FBX 리타게팅은 이진 FBX를 실제로 읽고 출력하며, 브라우저에서 사용하려면 Three.js와 FBX exporter CDN 접속이 필요합니다. 입력 FBX의 프레임 레이트 메타데이터는 아직 읽지 않아 기본 30 fps로 샘플링합니다. 변환은 소스와 대상 파일의 rest pose를 사용하며 A/T-pose 정렬 및 축 자동 보정은 없습니다. 키 편집은 회전 XYZ 숫자 입력 중심이고, 곡선 핸들·위치/스케일 키는 지원하지 않습니다. Story는 하드 컷으로 이어 붙이며 트랜지션 블렌드와 독립된 여러 모션 소스의 일괄 리타게팅은 아직 없습니다. 발 접촉·Aux IK는 정의된 2-bone 체인에 대한 단순 IK이며 팔꿈치/무릎 pole-vector 조절과 관절 제한은 제공하지 않습니다. 화면의 라이브러리 분류 행은 샘플 데이터이며 가져온 모션 파일 자체와 프로젝트 JSON을 연결해 재열기하는 세션 저장은 아직 없습니다. 사족·조류 Character Definition 및 REA 게임별 모션 추출기도 다음 확장 단계입니다.

## 권장 구현 순서

1. A/T-pose 정렬과 축 변환 프리셋을 대표 캐릭터 FBX로 검증합니다.
2. IK 관절 제한·pole-vector·발가락 보정과 뷰포트 Control Rig 핸들을 추가합니다.
3. 곡선 핸들 편집, Story 전환 블렌드와 다중 FBX 소스 시퀀싱, 프로젝트 세션 재열기를 추가합니다.
4. 사족·조류 Character Definition과 꼬리/날개 체인 프로필을 추가합니다.
5. 모션 메타데이터 영구 저장·검색과 품질 검사를 구현합니다.
6. REA 버전과 게임별 에셋 추출 어댑터를 연결해 모델 기준으로 묶고 세부 동작을 분류합니다.

그림 위에서 필수 본을 연결하고 매핑을 검증하는 흐름은 [MotionBuilder Character Mapping](https://help.autodesk.com/cloudhelp/2026/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-81EE03EF-066C-4442-B47A-25E4D43E0203.html)을 참고했습니다. 소스/대상 Spine 개수가 다를 때 체인에 회전을 분배하는 동작과 최대 10개 Spine 슬롯 정의는 [Spine mapping behavior](https://help.autodesk.com/cloudhelp/2026/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-CD5ED9F8-52DE-4DAA-BABA-38A196BF2466.html)와 [Defining a spine](https://help.autodesk.com/cloudhelp/2025/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-0AFB9286-450F-4C8D-A966-841B86BE0A43.html)을 참고했습니다.
