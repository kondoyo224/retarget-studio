# Retarget Studio

모캡과 게임 애니메이션을 가져와 리타게팅하고, 키를 정리하고, 모델별 동작 라이브러리에 분류한 뒤, 검수와 출력을 마치는 작업 도구의 프로토타입입니다. [웹 미리보기](https://kondoyo224.github.io/retarget-studio/). FBX 3D 읽기에는 Three.js를 CDN에서 불러오므로 웹 연결이 필요합니다.

## 사용자 흐름

1. **가져오기** — FBX를 읽어 모델·본 계층·첫 애니메이션 클립을 3D 뷰포트에서 확인합니다. 현재 FBX 미리보기 시간축은 30 fps 기준 추정입니다. BVH도 프레임 데이터로 읽고 재생합니다. 모캡 테이크, 출처, FPS와 프레임 범위도 관리합니다.
2. **리타게팅** — 표준 신체 의미 슬롯에 본을 연결하고, rest pose·축·단위를 보정합니다. IK/FK Control Rig, 발 접촉, Aux Effector로 결과를 조정합니다.
3. **키 편집** — 채널별 키와 FCurve를 편집하고, 스무딩·노이즈 완화·중복 키 감소를 적용합니다. 레이어와 Story 클립을 구성합니다.
4. **분류** — 캐릭터 모델을 모델 그룹으로 묶고, 그룹에 연결된 동작을 종·장비·행동·세부 동작·출처로 검색합니다.
5. **검수와 출력** — 필수 본, 선택 본, 체인 설정, 발 접촉, 분류 정보를 확인하고 포맷·프레임 범위·FPS·축·단위를 설정합니다.

## 체인 본 수가 다를 때

리타게팅은 `Spine`, `Neck`, `Tail`처럼 의미가 같은 본 체인 단위로 처리합니다. 예를 들어 소스 Spine이 3개, 대상 Spine이 5개면 본 하나씩 단순 복사하지 않고 체인 전체 회전을 대상 체인에 재분배합니다. 반대로 소스가 더 길면 여러 소스 회전을 누적해 더 짧은 대상 체인에 합칩니다. 화면 예제는 Neck 1개를 Neck 2개로 재분배합니다.

`retarget-core.js`에는 첫 번째 체인 재분배 수학을 넣었습니다.

- 소스 각 분절의 회전 변화량을 공통 체인 좌표계로 바꾸고 누적 방향 곡선을 만듭니다.
- 기본은 rest-pose 분절 길이를 정규화한 길이 가중 방식이며, 균등 또는 사용자 가중치도 선택할 수 있습니다.
- 대상 분절 경계에서 누적 회전을 구면 보간으로 샘플링하고, 이웃 샘플의 상대 회전을 대상 분절 회전으로 복원합니다.
- 체인의 시작 자세와 전체 끝 회전은 유지됩니다. 같은 수의 본과 같은 분절 위치라면 직접 전달과 동일하게 동작합니다.

이 수학 함수는 **공통 체인 좌표계에 정렬한 회전 변화량**을 입력으로 받습니다. 파일 어댑터가 본 축과 rest pose를 정렬하고 결과를 대상 rest pose로 되돌리는 작업은 아직 연결해야 합니다. 화면의 `분배 계산` 버튼은 예시 회전을 계산해 체인 알고리즘이 UI와 연결된 모습을 보여줍니다.

## 모션 라이브러리 데이터 구상

모델과 모션을 자유 텍스트 하나로만 저장하지 않고 서로 연결된 필드와 확장 가능한 태그로 분류합니다.

- **Model Group**: 모델 ID, 표시 이름, 모델 파일, 스켈레톤 프로필, 종/리그 유형
- **Motion Asset**: 모션 ID, 연결 Model Group, 파일, FPS, 프레임 범위, 루프 여부, Root motion 여부
- **분류 태그**: 출처(모캡/게임 추출/키 애니메이션), 무기(대검/활/비무장), 행동(이동/일상/공격/죽음/비행), 세부 동작(가로 베기/대각선 베기/인사/달리기/이륙), 좌우·방향, 품질 검수 결과
- **게임 추출 추적 정보**: 게임과 빌드, 원본 에셋 ID, 연결 모델 ID, 추출 도구·리포지터리 버전, 원본 파일 해시

사용자가 지정한 [REA 저장소](https://github.com/morluto/rea)는 앱·바이너리·런타임을 조사하는 역공학 에이전트 도구입니다. Godot PCK 등 일부 패키지 분석·추출 워크플로는 있지만, 게임 애니메이션을 공통 포맷으로 바로 변환해 주는 범용 모션 추출기는 아닙니다. 따라서 흐름은 **REA로 포맷과 참조 관계 조사 → 게임별 추출 어댑터 구현 → 공통 `Model Group`/`Motion Asset`으로 변환 → 리타게팅·라벨링**으로 나눕니다. 추출 어댑터는 게임별 규칙과 편집기를 분리하는 경계가 됩니다.

이 앱은 이 연결을 위한 `rea-motion-manifest.schema.json`을 정의하고, 라이브러리 화면에서 해당 형식의 JSON을 읽고 라벨을 편집합니다. [`rea-motion-manifest.example.json`](rea-motion-manifest.example.json)은 분류 화면을 확인하기 위한 가상 예시이며 실제 게임 추출 데이터가 아닙니다. 형식 버전 1에는 게임/빌드, 추출기와 리포지터리 버전, 모델과 종, 모션 파일, FPS/프레임, 무기, 행동/세부 동작, 방향, 루프/Root motion, 품질과 출처 추적 정보를 담습니다. 분류 후 같은 manifest 형식으로 다시 내보낼 수 있습니다.

## 현재 구현 범위

현재는 FBX 읽기, 모델·첫 애니메이션 클립의 3D 미리보기, 카메라 Orbit/Front/Side 전환, 스켈레톤 계층 표시, 그림 기반 Character Definition 본 배치와 필수 15개 슬롯 검증이 연결되어 있습니다. 슬롯은 그림에서 선택해 본 목록과 연결하거나 본을 끌어 놓을 수 있습니다. 선택 Spine 슬롯을 포함해 최대 10개 Spine 슬롯, Neck과 발가락 슬롯을 추가로 기록할 수 있습니다. Spine 추가 슬롯은 그림 아래 선택 목록에 표시됩니다. BVH 본 이름 자동 매핑과 BVH→BVH 리타게팅, 체인 회전 재분배, 프레임 구간/FPS 설정, BVH 다운로드도 동작합니다. Spine/Neck의 본 수가 다르면 누적 회전을 대상 체인 길이에 따라 분배합니다. Root translation은 크기 맞춤을 적용하고, `Extract` 설정은 별도 root translation JSON으로 내려받습니다. 모션 라이브러리 입력과 REA manifest 라벨 편집/출력도 동작합니다.

이 빌드는 작업 검증용 첫 변환기입니다. FBX는 [Three.js FBXLoader](https://threejs.org/docs/pages/FBXLoader.html)로 읽지만, FBX 소스→대상 모션 전송과 FBX 저장은 아직 연결되지 않았습니다. 현재 실제 리타게팅과 출력은 BVH 조합만 지원합니다. FBXLoader는 FBX 7 이상 ASCII 또는 6400 이상 Binary 버전을 대상으로 합니다. BVH 대상 첫 프레임을 기준 자세로 사용하고 본의 rest-world 회전 기준으로 재표현합니다. 별도 기준 자세 편집, FBX 축/단위 변환, Control Rig/IK, 실제 발 접촉 고정, 키 커브 편집과 레이어 합성도 미구현입니다. Three.js 모듈을 CDN에서 가져오므로 웹 연결이 필요합니다. 화면의 모션/분류 데이터는 예시입니다.

## 권장 구현 순서

1. FBX source/target 클립 전송을 연결하고 spine/neck 체인 재분배를 적용합니다.
2. FBX 기준 자세, 축/단위 변환과 캐릭터 타입별 Character Definition 템플릿을 추가합니다.
3. FBX 출력 백엔드를 정하고, FBX 결과를 다른 DCC에서 열어 검증합니다.
4. 2-bone IK, 실제 발 접촉 고정, Control Rig와 Aux Effector를 모션 데이터에 연결합니다.
5. 키 커브 편집, 레이어 합성, Story 클립 블렌드와 프로젝트 내 모션 저장을 구현합니다.
6. 모션 메타데이터 영구 저장/검색, 품질 검사와 게임별 에셋 추출 어댑터를 추가합니다.

그림 위에서 필수 본을 연결하고 매핑을 검증하는 흐름은 [MotionBuilder Character Mapping](https://help.autodesk.com/cloudhelp/2026/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-81EE03EF-066C-4442-B47A-25E4D43E0203.html)을 참고했습니다. 소스/대상 Spine 개수가 다를 때 체인에 회전을 분배하는 동작과 최대 10개 Spine 슬롯 정의는 [Spine mapping behavior](https://help.autodesk.com/cloudhelp/2026/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-CD5ED9F8-52DE-4DAA-BABA-38A196BF2466.html)와 [Defining a spine](https://help.autodesk.com/cloudhelp/2025/ENU/MotionBuilder-Character-Animation/files/Character-Animation/Character-setup/Character-assets/GUID-0AFB9286-450F-4C8D-A966-841B86BE0A43.html)을 참고했습니다.
